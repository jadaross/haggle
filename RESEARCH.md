# Haggle — Research & Design Document
> AI-powered Vinted seller automation · April 2026

---

## Table of Contents

1. [What Exists Today](#1-what-exists-today)
2. [The Vinted API Landscape](#2-the-vinted-api-landscape)
3. [DataDome — The Real Wall](#3-datadome--the-real-wall)
4. [Terms of Service & Risk Model](#4-terms-of-service--risk-model)
5. [What Sellers Actually Want](#5-what-sellers-actually-want)
6. [Architecture Options](#6-architecture-options)
7. [Recommended Design](#7-recommended-design)
8. [Claude Prompting Strategy](#8-claude-prompting-strategy)
9. [Open Source Strategy](#9-open-source-strategy)
10. [The Critical Unknowns](#10-the-critical-unknowns)
11. [Go / No-Go Assessment](#11-go--no-go-assessment)

---

## 1. What Exists Today

### Commercial Extensions (the incumbents)

| Tool | Model | Key features | Weakness |
|---|---|---|---|
| **Dotb** | €0–€25/mo | Message likers, AI reply, reposts, offers, bulk edit, multi-account, Sheets sync | Browser must stay open (unless paying for cloud tier) |
| **Bleam** | Undisclosed | AI rewritten descriptions, image transform (defeats hash detection), cloud mode, bundle deals, auto-negotiate | Closed source, pricing opaque |
| **Vintex** | ~€12/mo | Reposts, auto-replies, multilingual | One confirmed account block immediately after payment |
| **VBot** | Free | Auto-likes, follows, favourites management | Minimal, maintenance unclear |
| **Grow Bot** | Free tier | Offers to likers, welcome messages | Limited intelligence |

**Key pattern:** Every commercial tool is a Chrome extension operating inside the seller's own browser session. None are external server-side bots. This is deliberate — the extension inherits a legitimate session cookie, and browser-generated traffic is indistinguishable from human use.

### Open-Source Landscape

| Repo | Stars | Status | Notes |
|---|---|---|---|
| callycodes/vinted-seller-bot | 10 | Abandoned (2023) | Node.js, messages favourite-ers, CSRF-based auth — likely broken |
| 2spy/Vinted-Discord-Bot | 328 | Active | Go, buyer-side only |
| teddy-vltn/vinted-discord-bot | 168 | Active | JS, zero-delay listing alerts |
| Giglium/vinted_scraper | 55 | Active (v3.1.0, Apr 2026) | Read-only Python, 403 issues on `item()` |
| Fuyucch1/Vinted-Notifications | 145 | Active | Real-time listing alerts |

**The gap:** No maintained open-source project covers the seller automation stack (detect favourite → craft message → send → handle reply → manage offer). The callycodes bot attempted it but is dead. This is the genuine open-source opportunity.

---

## 2. The Vinted API Landscape

### Authentication Layers

Vinted runs three credential types simultaneously:

| Token | Purpose | Lifetime | How to get |
|---|---|---|---|
| `access_token_web` | JWT bearer for web API requests | ~2 hours | Auto-extracted from homepage cookie |
| `refresh_token_web` | Refreshes access tokens | Longer (days?) | Co-extracted with access token |
| `datadome` | DataDome validation cookie | Session | Injected by DataDome JS challenge |

**Web API auth in practice (confirmed from HAR):** All requests use `x-csrf-token` header (a UUID, e.g. `75f6c9fa-dc8e-4e52-a000-e09dd4084b3e`), not a Bearer token. The session cookie carries the actual authentication; the CSRF token is a per-session value extracted from the page.

**The mobile app uses none of these** — it uses `Authorization: Bearer {token}` from the app's own OAuth flow, and DataDome doesn't appear to protect mobile API endpoints at all.

### Known Endpoints

**Read (confirmed working):**
```
GET /api/v2/catalog/items?search_text=...&page=1&per_page=96
GET /api/v2/items/{id}
GET /api/v2/items/{id}/more
GET /api/v2/users/{id}
GET /api/v2/users/{id}/items
GET /api/v2/feedbacks
GET /api/v2/notifications          ← key for favourite detection
GET /api/v2/inbox                  ← conversation list
GET /api/v2/inbox/{conversation_id}
GET /api/v2/conversations/{id}
GET /api/v2/conversations/stats    ← returns {"unread_msg_count": N, "code": 0}
GET /api/v2/transactions/{id}
GET /api/v2/transactions/{id}/offers/seller_options
```

**Write (confirmed working via web session — HAR captured April 2026):**
```
POST /api/v2/conversations
POST /api/v2/conversations/{id}/replies
POST /api/v2/transactions/{id}/offers
POST /api/v2/offer/estimate_with_fees
POST /api/v2/offers/request_options
```

**Write request schemas:**

Start a conversation (from a notification click):
```json
POST /api/v2/conversations
{"initiator": "seller_enters_notification", "item_id": "8294435478", "opposite_user_id": "145161066"}
```

Send a message in an existing conversation:
```json
POST /api/v2/conversations/{id}/replies
{"reply": {"body": "Hi, still available!", "photo_temp_uuids": null, "is_personal_data_sharing_check_skipped": false}}
```

Make a price offer on a transaction:
```json
POST /api/v2/transactions/{id}/offers
{"offer": {"price": "70", "currency": "GBP"}}
```

Get offer constraints before sending (reveals Vinted's floor price, max discount, and remaining offer count):
```json
POST /api/v2/offers/request_options
{"price": {"amount": "30.0", "currency_code": "GBP"}, "item_ids": ["8004516124"], "seller_id": 111088593}
```
Response:
```json
{
  "request_options": {
    "max_discount": "0.4",
    "min_price": {"amount": "18.0", "currency_code": "GBP"},
    "max_price": {"amount": "30000.0", "currency_code": "GBP"},
    "remaining_offer_count": 25,
    "max_offer_count": 25,
    "offer_suggestions": [
      {"label": "5% off", "price": {"amount": "28.5", "currency_code": "GBP"}},
      {"label": "10% off", "price": {"amount": "27.0", "currency_code": "GBP"}}
    ]
  }
}
```

Estimate fees before making an offer:
```json
POST /api/v2/offer/estimate_with_fees
{"item_ids": ["8294435478"], "offer_price": {"amount": "70", "currency_code": "GBP"}, "fees": ["buyer_protection"]}
```

**Key constraints from offer system:**
- Vinted enforces a max discount of **40%** from listed price
- Per-item offer cap: **25 offers** per item across all buyers
- `min_price` in `request_options` response is Vinted's calculated floor — do not send offers below it or they'll be rejected

### The Notifications Endpoint — Key to Favourite Detection

Favourite/like events appear in `/api/v2/notifications`. The callycodes bot polled this endpoint. The structure is unverified for current Vinted but likely looks like:
```json
{
  "notifications": [
    {
      "type": "item_liked",
      "user_id": 12345,
      "item_id": 67890,
      "created_at": "..."
    }
  ]
}
```

**Poll interval recommendation:** Every 5–15 minutes. Faster than that and you risk rate limits or behavioural flags.

### vinted-scraper Package (Giglium/vinted_scraper)

- Current version: v3.1.0 (April 19 2026), MIT, actively maintained
- Does: search, item detail, raw endpoint access — **read only**
- Known issue: `item()` endpoint returns 403 frequently after repeated calls
- No cookie refresh logic built in
- Has both sync and async variants

**Bottom line:** Useful for prototype reads. Not production-grade for write operations or sustained polling.

---

## 3. DataDome — The Real Wall

DataDome processes 5 trillion signals per day, under 2ms per request, with **per-customer custom models**. Vinted specifically contracted DataDome after achieving a 95% reduction in fake account creation. You are not fighting a generic bot detector — you are fighting a model trained specifically on Vinted traffic.

### What It Detects

| Layer | Signals |
|---|---|
| TLS fingerprinting (JA3) | Each HTTP client library has a unique TLS handshake signature |
| HTTP inspection | Header order, User-Agent format, HTTP version (HTTP/1.1 flagged) |
| IP reputation | Datacenter ranges blacklisted; cloud IPs (Railway, AWS, GCP) are all flagged |
| JavaScript fingerprinting | Canvas/WebGL renders, navigator properties, screen/hardware details |
| Picasso (GPU-level) | Canvas pixel differences per GPU/driver — nearly impossible to spoof in software |
| Behavioural ML | Mouse, scroll, timing, navigation flow, concurrent request patterns |
| Intent analysis (2025) | What the session is actually doing, not just how it looks |

### Bypass Feasibility

| Technique | Against DataDome/Vinted |
|---|---|
| Plain requests/httpx | Fails immediately |
| Standard Playwright | Fails (webdriver flag, CDP detection) |
| Playwright + stealth | Partial — insufficient for per-Vinted model |
| Camoufox / Nodriver | Better, but not guaranteed |
| curl-impersonate | Good for GET-only flows |
| Residential proxies | Required companion to any technique |
| Mobile API path | **Bypasses DataDome entirely** — the practical path |

### The Mobile API Path

The Vinted mobile app talks to the same `/api/v2/` backend but via a different auth flow and without DataDome middleware in the chain. If you can:

1. Authenticate as a mobile app session (reverse-engineer the mobile OAuth flow)
2. Identify working write endpoints from the app's traffic

...you get a DataDome-free API surface. This requires intercepting traffic from the Vinted iOS/Android app using a MITM proxy (Charles, mitmproxy). This is the **most promising technical spike** for the project.

---

## 4. Terms of Service & Risk Model

### What Vinted's ToS Prohibits

- Automated bulk actions (mass messaging, mass listing, mass resharing)
- Scraping content
- Third-party tools that perform actions without human input
- Multi-account operation

### Enforcement Reality (2026)

Vinted replaced human moderation with an AI **Behavioural Identity** system that tracks each account persistently:

| Trigger | Penalty |
|---|---|
| Report clusters + borderline automation | 7–14 day restriction |
| Moderate automation signals | Shadowban (listings invisible, no notification) |
| Aggressive automation, clear ToS violation | Permanent ban + 180-day wallet freeze |
| Post-ban new account from same device | SS06 error within hours |

**January 2026:** Perceptual hash detection for relisted images introduced. Same photos re-uploaded = flagged. Tools like Bleam now apply image transforms automatically.

### Your Specific Risk Profile

Sending **one personalised message per favourite event** is fundamentally different from mass messaging. The key risk factors:

- **High risk:** Messages sent seconds after a favourite event (suspiciously fast)
- **High risk:** Identical message text to every person (clearly templated)
- **Medium risk:** Polling notifications from a datacenter IP
- **Lower risk:** Randomised delays (5–30 min after favourite event), genuinely varied LLM text, human-like session patterns

The extension-based tools work because they inherit a real browser session. A server-side bot generating Vinted-like requests from Railway will need the mobile API path or a Playwright wrapper running behind a residential proxy to be sustainable.

---

## 5. What Sellers Actually Want

Research across seller communities surfaces these pain points in priority order:

### 1. Message buyers who favourited items ← **#1 demand, highest conversion impact**
Buyers who favourite but don't buy are identified as the single highest-value automation target. A buyer contacted within 24 hours of favouriting is **3x more likely to complete a purchase**. Yet doing this manually for a 200-item wardrobe is impossible.

Current commercial tools charge up to €25/month for this single feature. Dotb's "Boutique AI" plan (unlimited messages to likers) is their top tier specifically because of this.

### 2. Listing republishing / bumping
Vinted's algorithm weights recency heavily. A relisted item gets 200–300% more views in its first hours. Every seller wants this automated.

**Complication (Jan 2026):** Perceptual hash detection means re-uploading same photos risks a shadowban. Need image transforms — rotate, crop, brightness adjustment. Bleam does this. This makes the feature meaningfully harder to build correctly.

### 3. Offer negotiation
~70% of buyers negotiate on price. Power sellers dealing with 40+ offers/day need:
- Auto-accept if above floor price
- Auto-counter at midpoint
- Auto-decline below minimum threshold

### 4. Inbox management
Vinted's inbox is described as "simply unusable" by power sellers — no filters, no labels, no way to distinguish active negotiations from dead ones.

### 5. Bulk shipping operations
~1.5 min per label × 30 sales/week = 45 min/week. Bulk label download is a real QoL win.

### 6. Cross-listing
List to Depop, eBay, Vinted simultaneously. Souk, SellerAider, and commercial tools play here. Bigger market, higher complexity.

### What Users Don't Have and Can't Get Elsewhere

No tool offers **genuine conversational intelligence** — they all use templates or basic keyword-triggered responses. The "AI reply" features in Dotb and Bleam are not agentic — they suggest replies but don't autonomously negotiate across multiple turns. This is the genuine Claude differentiator.

---

## 6. Architecture Options

### Option A: Chrome Extension (Browser-in-the-Loop)

The dominant commercial pattern. Extension runs in seller's browser, uses their live session.

**Pros:**
- Zero DataDome risk (inherits real browser session)
- Proven pattern (Dotb, Bleam, Vintex all do this)
- Write operations work exactly as a human would
- No server needed for core function

**Cons:**
- Browser must be open (unless using cloud sync via messaging)
- Not headless 24/7 on Railway
- Not really a "backend agent"
- Python not the native language (would use JS/TS)
- Harder to open-source attractively (extension UX overhead)

### Option B: Server-Side Bot via Web API + DataDome Bypass

External Python bot hits the web API, attempts DataDome bypass via Camoufox/stealth browser.

**Pros:**
- Fully headless, Railway-native
- Python-native
- Matches original vision

**Cons:**
- DataDome is a real and actively maintained wall
- Residential proxy cost (typically $10-30/month)
- Railway IPs are datacenter-flagged
- Fragile: DataDome model updates can break it overnight
- 2-hour token expiry + complex cookie refresh loop

**Verdict:** Technically ambitious but brittle. Not a good foundation for an open-source project others can run reliably.

### Option C: Server-Side Bot via Mobile API (Reverse Engineered)

Intercept Vinted iOS/Android app traffic with mitmproxy, identify auth flow and write endpoints, build Python client against the mobile API surface.

**Pros:**
- No DataDome (mobile API bypasses it)
- Headless, Railway-native
- Python-native
- More stable if mobile auth tokens last longer than web tokens
- Discovery of undocumented write endpoints is the key research value

**Cons:**
- Requires initial traffic interception research (spike needed)
- Mobile auth flow may require app attestation or certificate pinning
- No community documentation to rely on
- Risk of breaking if Vinted updates mobile auth

**Verdict:** Highest upside, highest upfront research cost. The `callycodes/vinted-seller-bot` project used CSRF/cookies from Chrome DevTools — mobile would be cleaner.

### Option D: Hybrid — Extension Bridge + Cloud Agent

Browser extension handles auth, session management, and write operations. It relays data (new favourites, incoming messages) to a Railway-hosted agent that does the Claude reasoning and sends instructions back to the extension.

**Pros:**
- Extension inherits legitimate session (safe)
- Intelligence lives on server (Railway, headless, 24/7)
- Claude API called server-side (no API key in extension)
- Architecturally clean separation of concerns

**Cons:**
- Extension must be open (acts as a browser bridge, not automation per se)
- Two components to maintain and distribute
- UX/install friction for users

**Verdict:** Actually elegant if you're willing to ship a browser component. The extension becomes a thin bridge (WebSocket or polling to Railway), not the automation engine. Users could have the tab running passively in a pinned background tab.

### Option E: Playwright Session Manager (Semi-Headless)

Playwright controls a real browser on Railway, handles login + session maintenance, executes write operations through the real browser UI. DataDome sees a real browser.

**Pros:**
- Legitimate browser = passes DataDome
- Write operations reliable
- Fully headless on Railway

**Cons:**
- Playwright on Railway needs browser binary (possible but resource-heavy)
- CAPTCHA challenges during login require manual intervention or 3rd-party CAPTCHA solving
- Memory-heavy per-instance

**Verdict:** Viable for a personal tool, fragile for general open-source distribution. Users managing their own Vinted session would need to handle login manually.

---

## 7. Recommended Design

### Phase 1: Research Spike (Before Writing Any Production Code)

**Week 1 goal:** Determine if mobile API write operations are feasible.

1. Install mitmproxy on macOS, configure iPhone to route Vinted traffic through it
2. Log in to Vinted iOS app
3. Send a message to a test buyer
4. Record the exact HTTP request (endpoint, headers, auth token format, body schema)
5. Replay that request from Python — if it works, the architecture decision is made

This spike answers the most important unknown. If mobile write ops work, build Option C. If not, build Option D.

### Phase 2: Core Agent (If Mobile API Works)

```
Railway cron / scheduler
    ↓
Poll /api/v2/notifications every 10 minutes
    ↓
Filter for "item_liked" events not previously seen
    ↓
Load item details + user profile
    ↓
Claude API: generate personalised message
    ↓
POST to conversation endpoint
    ↓
Log to PostgreSQL (event, message, timestamp, user_id, item_id)
```

### Token Management

```python
class VintedSession:
    access_token: str
    refresh_token: str
    token_expiry: datetime
    
    def ensure_valid(self):
        if datetime.now() > self.token_expiry - timedelta(minutes=10):
            self.refresh()
    
    def refresh(self):
        # POST to refresh endpoint with refresh_token
        # OR re-authenticate from scratch with stored credentials
        ...
```

Credentials (email/password or session tokens) live in Railway env vars. On token expiry, either use the refresh token or reauthenticate. This needs reverse-engineering as part of the mobile spike.

### Human-Like Behaviour Layer

```python
import random
import asyncio

async def process_favourite_event(event):
    # Never act immediately — simulate human reading time
    delay = random.uniform(5 * 60, 30 * 60)  # 5-30 minutes
    await asyncio.sleep(delay)
    
    # Generate message with Claude
    message = await generate_negotiation_message(event)
    
    # Send
    await send_message(event.user_id, event.item_id, message)
    
    # Rate limit: max N messages per day
    await record_action()
```

### Database Schema

```sql
-- Favourite events we've seen
CREATE TABLE favourite_events (
    id SERIAL PRIMARY KEY,
    vinted_user_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL,
    processed_at TIMESTAMPTZ,
    status TEXT DEFAULT 'pending'  -- pending, sent, skipped, error
);

-- Messages we've sent
CREATE TABLE sent_messages (
    id SERIAL PRIMARY KEY,
    favourite_event_id INT REFERENCES favourite_events(id),
    conversation_id TEXT,
    message_text TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL,
    claude_model TEXT,
    prompt_tokens INT,
    completion_tokens INT
);

-- Daily rate limit tracking
CREATE TABLE daily_actions (
    date DATE PRIMARY KEY,
    messages_sent INT DEFAULT 0,
    messages_limit INT DEFAULT 20
);
```

---

## 8. Claude Prompting Strategy

### The Core Problem with Templates

Every existing tool uses templates. "Hi! I noticed you liked my [item]. I can offer you 10% off if you buy today!" — buyers can recognise these instantly. Template messages have declining effectiveness as more sellers use the same tools.

### Claude's Genuine Differentiator

A model that reasons about:
- What the buyer liked and why (price range, style, the specific item)
- Whether they liked multiple items (bundle opportunity)
- The seller's floor price vs. listed price (negotiation room)
- Time since the favourite (urgency framing)
- The buyer's profile (if visible — their favourites, their reviews)

### System Prompt Design

```python
SYSTEM_PROMPT = """
You are helping a Vinted seller send personalised messages to buyers who have favourited their items.

Your goal is to write a short, natural message (2-4 sentences) that:
- Feels genuinely personal, not templated
- Mentions something specific about the item(s) they liked
- Makes a concrete offer or suggestion
- Doesn't feel pushy or salesy
- Sounds like a real person wrote it

Rules:
- Never use "I noticed you liked..." as an opener — it's overused
- Don't offer discounts unless the item has margin (floor_price provided)
- If they liked multiple items, suggest a bundle deal
- Match the tone to the price point (casual for cheap items, more considered for expensive ones)
- Keep it under 100 words
- Write in English unless told otherwise

The seller's persona: {seller_persona}
"""

USER_PROMPT = """
The buyer has favourited:
{items_favourited}

Seller's floor prices:
{floor_prices}

Buyer profile snippet (if available):
{buyer_info}

Time since favouriting: {time_delta}

Write the message.
"""
```

### Multi-Turn Conversation Handling

Phase 2 feature — but the architecture should account for it. When a buyer replies, pull the conversation history and let Claude continue the negotiation:

```python
NEGOTIATION_SYSTEM = """
You are continuing a negotiation on behalf of a Vinted seller.

Seller constraints:
- Minimum acceptable price: {floor_price}
- Willing to bundle: {bundle_policy}
- Maximum discount from listed price: {max_discount}%

Negotiation rules:
- Accept if buyer's offer >= floor_price
- Counter at midpoint if buyer's offer is within 20% below floor
- Politely decline if below floor, explain why
- Never reveal the exact floor price
- Be warm but firm

Conversation so far:
{conversation_history}
"""
```

---

## 9. Open Source Strategy

### Why Open Source Actually Wins Here

1. **Trust** — sellers are handing over their Vinted credentials. Open source is the only credible way to say "we don't store your password" and have users believe it.
2. **Community** — reverse-engineered API endpoints go stale. A community of contributors keeps the endpoint docs current.
3. **Portfolio** — "I built the open-source Dotb alternative" is a strong narrative. The project is cite-able in the AI agent space with the Anthropic Project Deal connection.
4. **Monetisation** — open-source core + Railway one-click deploy button + optional managed tier at low cost. This is the Plausible/Cal.com model.

### GitHub Positioning

The README pitch:
> **Haggle** — An AI agent that negotiates Vinted sales while you sleep. Open source, runs on Railway, uses Claude for genuinely personalised messages (not templates). No browser required.

The differentiators to lead with:
- Server-side (no browser tab to keep open)
- LLM reasoning, not templates — messages that don't sound like bot messages
- Full audit log of every action taken on your behalf
- Self-hostable; you own your credentials
- Open source — audit every line

### Repository Structure

```
haggle/
├── agent/
│   ├── __init__.py
│   ├── vinted/
│   │   ├── client.py          # Vinted API client (mobile auth path)
│   │   ├── session.py         # Token management + refresh
│   │   ├── models.py          # Pydantic models for API responses
│   │   └── endpoints.py       # All known endpoints documented
│   ├── claude/
│   │   ├── negotiator.py      # Message generation
│   │   └── prompts.py         # Versioned prompt templates
│   ├── scheduler.py           # Polling loop
│   └── rate_limiter.py        # Daily action limits + delays
├── db/
│   ├── migrations/            # SQL migrations
│   └── models.py              # SQLAlchemy models
├── config.py                  # Env-based config
├── main.py                    # Entry point
├── railway.json               # Railway deploy config
├── Dockerfile
├── pyproject.toml
├── RESEARCH.md                # This document
└── README.md
```

### One-Click Deploy

Railway supports `railway.json` + a deploy button in the README. This is the zero-friction path for non-technical sellers. Pair it with a `SETUP.md` that walks through getting your Vinted session tokens.

---

## 10. The Critical Unknowns

These need answers before committing to an architecture. In order of priority:

### Unknown 1: Can write operations (messages/offers) work via mobile API?
**How to resolve:** mitmproxy spike. Intercept Vinted iOS app traffic during a message send. Estimated time: 2–4 hours.

**Partial answer (April 2026):** Write operations are confirmed working on the **web API** (`POST /conversations`, `POST /conversations/{id}/replies`, `POST /transactions/{id}/offers`) — see the confirmed endpoints above. The mobile API question remains open for the server-side headless architecture. Current focus is web API via extension bridge (Option D).

### Unknown 2: Does the mobile auth flow support long-lived tokens?
Web tokens expire every 2 hours. If mobile tokens last days/weeks, it changes the session management design completely.

### Unknown 3: Does the mobile API require certificate pinning?
Vinted may implement SSL pinning on the iOS app, which blocks mitmproxy. Workaround: use an older APK version, use Frida to bypass pinning, or test the Android app which is easier to instrument. If pinned, this spike fails and we fall back to Option D (extension bridge).

### Unknown 4: What is the actual notifications endpoint schema?
The callycodes bot (2023) polled notifications. We don't know if that endpoint still exists or if the schema has changed. Need to verify via either the mobile spike or careful web session testing.

### Unknown 5: What is Vinted's actual rate limit on notifications polling?
No community data exists. Start at 15-minute intervals; back off on 429s.

---

## 11. Go / No-Go Assessment

### What Makes This Worth Building

- **Real market gap:** No open-source headless seller automation exists. The callycodes bot is abandoned.
- **LLM differentiation is genuine:** Template messages are table stakes; actual negotiation intelligence is not available in any current tool.
- **Community demand is clear:** Favourite-to-message is the single highest-demand feature; current tools charge €25/month for it.
- **Portfolio value is high:** AI agent for real-world marketplace negotiations is exactly the Anthropic Project Deal narrative.

### The Honest Risk Register

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Mobile API write ops don't work (certificate pinning, no endpoints) | High | Medium | mitmproxy spike answers this before writing any production code |
| DataDome blocks web API entirely | High | High (if using web path) | Mobile API path bypasses; extension bridge as fallback |
| Vinted account ban during development/testing | High | Low-Medium | Use a test account with nothing at stake; delay randomisation |
| Mobile API auth changes break the agent | Medium | Medium | Design session management to be hot-swappable; community can patch |
| Open-source uptake is low | Low | Low-Medium | Even 50 GitHub stars validates the concept; personal use is still valuable |
| Vinted legal action | Very Low | Very Low | No precedent exists; individual seller use is unlikely to attract legal attention |

### Recommended Go Decision

**Go, with the mobile API spike as a hard gate.** 

Do the mitmproxy research before writing any production code. If write operations work via mobile API, you have a clean headless architecture with no DataDome. If they don't, the extension bridge option (Option D) still delivers the core value proposition — it's just a different distribution model.

The project is worth building regardless. The open-source gap is real. The Claude angle is a genuine differentiator. The risk is manageable with a test account and conservative rate limits.

---

## Next Steps (Proposed)

- [x] **Spike:** Capture web API traffic via browser HAR — write endpoints confirmed working
- [ ] **Spike:** Poll notifications endpoint with web session → verify favourite events appear and document schema
- [ ] Build `VintedWebSession` class — extract CSRF token + session cookie, handle 2-hour token refresh
- [ ] Build notification poller with deduplication (start at 10-min interval, back off on 429)
- [ ] Build Claude negotiation layer
- [ ] Build extension bridge (Option D) — extension relays favourite events to Railway via WebSocket/polling, agent sends messages back through extension
- [ ] Set up PostgreSQL on Railway
- [ ] Test end-to-end on a test account with conservative limits
- [ ] Write README with Railway deploy button
- [ ] Open GitHub repo
- [ ] **Deferred:** mitmproxy mobile API spike (revisit if extension bridge proves too fragile)

---

*Research compiled April 2026. Sources: vinted-scraper GitHub (Giglium/vinted_scraper, v3.1.0), Dotb.io, Bleam.app, DataDome threat research, ZenRows/Scrapfly bypass guides, Vinted seller communities, callycodes/vinted-seller-bot, lobstr.io Vinted agent article, Vinted Pro API docs.*
