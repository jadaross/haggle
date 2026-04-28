# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Haggle is a two-part system that auto-messages Vinted buyers who favourite the seller's listings:

1. **Chrome extension** (`extension/`) — polls Vinted's internal notification API, detects new favourites, schedules delayed sends via `chrome.alarms`, calls the backend to generate a message, then sends it through Vinted's conversation API using the user's live browser session.
2. **FastAPI backend** (`backend/`) — validates the API key, deduplicates events, checks rate limits, calls Claude to generate a personalised opening message, and persists everything to PostgreSQL. Deployed to Render (`backend/render.yaml`).

## Backend commands

All commands run from `backend/`.

```bash
# Install (editable + dev extras)
pip install -e ".[dev]"

# Run locally (reads backend/.env)
uvicorn app.main:app --reload

# Run all tests
pytest

# Run a single test file
pytest tests/path/to/test_file.py

# Create a new migration
alembic revision --autogenerate -m "description"

# Apply migrations
alembic upgrade head
```

`backend/.env` is gitignored. Copy `backend/.env.example` and fill in values.

## Extension

No build step. Load it in Chrome via **Extensions → Load unpacked → select the `extension/` directory**.

## Architecture

### Request flow

```
Vinted tab (browser)
  └─ extension service-worker polls /notifications every 10 min
       └─ new favourite detected → chrome.alarms schedules a send (5–30 min delay)
            └─ alarm fires → POST /events/favourite to backend
                 └─ backend: auth → deduplicate → rate-limit → Claude → persist
                      └─ returns message_text
                           └─ extension calls Vinted /conversations + /replies
                                └─ POST /events/{id}/sent to confirm
```

### Key design decisions

**Extension Vinted calls use `chrome.scripting.executeScript`** — all Vinted API calls are injected into an open `vinted.co.uk` tab so session cookies are sent automatically. No Bearer token handling is needed. An open Vinted tab is required at poll and send time.

**CSRF capture via main-world fetch trap** — Vinted signs every `/api/v2/*` request with `x-csrf-token` + `x-anon-id` headers. The CSRF token lives in JS memory the isolated-world content script can't reach, so `content-script/main-world-trap.js` runs in the page's MAIN world at `document_start`, wraps `window.fetch` and `XMLHttpRequest`, sniffs the CSRF off outgoing headers, and stashes it on `document.documentElement.dataset.haggleCsrf`. Every injected API helper in `lib/vinted-api.js` reads from that DOM attribute + the `anon_id` cookie before fetching.

**`chrome.alarms` instead of `setInterval`** — MV3 service workers are killed after ~30s of inactivity. Alarms survive worker termination and are the only reliable timer in MV3.

**Dual-layer rate limiting** — the extension does a client-side check against `chrome.storage` counts; the backend enforces it again against `daily_rate_limits` in Postgres. The backend also applies a hard cap (`HARD_DAILY_CAP`, default 50) regardless of per-key config.

**API keys are stored hashed** — raw keys are SHA-256 hashed (`event_processor.py:hash_key`) before any DB writes. The hash is used as a foreign key across tables.

**Prompt versioning** — every `SentMessage` row records `prompt_version` (set in `app/prompts/v1_opening.py` as `VERSION = "v1_opening"`). When changing the prompt, bump the version string so historical rows stay attributed correctly.

### Vinted endpoint quirks (verified April 2026)

Things that look wrong on first read but are intentional. Don't "fix" these without checking the HAR / re-running the extension end-to-end:

- **Notifications live on a different host:** `https://api.vinted.co.uk/inbox-notifications/v1/notifications` is the working endpoint. `www.vinted.co.uk/api/v2/notifications` returns 404 in UK. `lib/vinted-api.js:fetchNotifications` tries multiple candidates and uses whichever returns 200.
- **Notification links use `vintedfr://` deep-link scheme,** e.g. `vintedfr://messaging?item_id=X&user_id=Y&portal=fr`. The `vintedfr` prefix is a global Vinted convention (kept from when Vinted was France-only) and `portal=fr` is just routing metadata — the IDs inside are UK records. `service-worker.js:parseFavouriteLink` extracts `item_id` / `user_id` from query params; never look for `/items/{id}` path segments.
- **Favourite notifications are `entry_type === 20`.** Type 50 = price drop on a favourited item; 290 = leave-feedback nudge. Filter in `deduplicator.js:isItemLikeNotif`.
- **No public item-fetch API.** `/api/v2/items/{id}` returns 404, `/details` returns 403 for items the seller themselves owns, `/info` returns 404. There is no working API to fetch your own item's details from your own session. `lib/vinted-api.js:fetchItem` falls through to an HTML scrape, then to a stub built from the notification body's title hint via `service-worker.js:extractTitleHint`.
- **Vinted runs Next.js App Router with RSC.** Item HTML pages no longer ship `<script id="__NEXT_DATA__">`; data streams via `<script>self.__next_f.push([1, "..."])</script>` chunks instead. `fetchItem` parses both shapes (`extractItemFromRSC` walks the chunks looking for an item-shaped node).
- **`api.vinted.co.uk` is CORS-blocked from `www.vinted.co.uk` origin** for most endpoints — except those that explicitly emit ACAO headers (notifications/inbox-notifications). Don't add cross-host fallbacks for items or users.

### Service worker debug helpers

When working on the extension, these are exposed on `self` in the SW console (chrome://extensions → "service worker" link):

- `await debugForceQueue()` — fetch the first favourite notification, bypass dedup, force the result into the pending-review queue regardless of mode. The fastest way to verify the full pipeline (notifs → item/user fetch → backend → queue → sidebar render).
- `await debugForceSend()` — same but respects mode (auto-sends in auto mode).
- `await debugClear()` — wipe `likes_log`, `pending_queue`, `seen_events`, daily counter. Settings (toggle / API key / mode / floor) survive. Used to reset state between test runs.

`chrome.runtime.sendMessage(...)` does NOT work from the SW console — the SW doesn't receive its own outbound messages. Always call the `self.debug*` helpers directly.

### Database tables

| Table | Purpose |
|---|---|
| `api_keys` | Per-seller keys with floor_pct, daily_limit, persona |
| `favourite_events` | One row per notification; status tracks pipeline stage |
| `sent_messages` | Generated messages with token counts and latency |
| `daily_rate_limits` | Rolling daily counter keyed by (api_key_hash, date) |
| `checkpoints*` | LangGraph schema stubs for a future multi-turn V2 |

### Event status lifecycle

`received` → `generating` → `sent` (happy path)  
`received` → `rate_limited` (daily cap hit)

### Backend module layout

- `app/adapters/` — parse raw extension payloads into typed dataclasses (`base.py` defines `FavouriteEvent`, `Item`, `Buyer`)
- `app/services/event_processor.py` — the main pipeline function; orchestrates all steps
- `app/services/claude_service.py` — thin Anthropic SDK wrapper; returns a `GeneratedMessage`
- `app/prompts/v1_opening.py` — prompt templates and `build_user_prompt()`
- `app/routers/` — FastAPI route handlers (events, stats)
- `app/db/` — SQLAlchemy async engine, models, Alembic migrations

## Deployment

Backend deploys to Render via `backend/render.yaml`. Push to `main` triggers a redeploy. The `DATABASE_URL` is injected automatically from the linked Render Postgres instance; `ANTHROPIC_API_KEY` must be set manually in the Render dashboard.
