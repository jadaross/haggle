# Haggle — Depop Platform Feasibility
> Research compiled April 2026. Assesses effort to extend the Haggle Chrome extension + Python backend to support Depop alongside Vinted.

---

## Summary Verdict

**Feasibility: HIGH.** Depop is structurally more accessible than Vinted for the extension bridge pattern. It uses Cloudflare (not DataDome), which the extension approach bypasses entirely. The existing `FavouriteEvent` / adapter architecture maps cleanly — the backend (Claude, rate limiter, event processor, DB) is 100% reusable. A working Depop adapter requires ~400–500 lines of new code, gated on a single 2–4 hour HAR capture session to confirm endpoint URLs and auth token format.

---

## 1. API Surface

### Official API (not useful for Haggle)

Depop has an invite-only **Partner Selling API** at `partnerapi.depop.com` — OAuth 2.0, covers inventory and order management only. No messaging, no notifications/likes feed. Requires approval from `[email protected]`. Not the path for Haggle.

### Internal Web/Mobile API (`api.depop.com`)

The undocumented API powering the web and mobile apps. Community reverse-engineering has confirmed:

```
POST https://api.depop.com/oauth2/access_token  ← mobile login
GET  https://api.depop.com/api/v1/users/{username}/
GET  https://api.depop.com/api/v1/users/{user_id}/items/
GET  https://api.depop.com/api/v1/products/{product_id}/
GET  https://api.depop.com/api/v3/attributes/
```

The endpoints needed for Haggle — **notifications/likes feed** and **messaging POST** — are used by commercial extension bots (SellerAider, Ceepop, Debob) but not publicly documented. They need a HAR capture session before building. Best-effort estimates:

```
# --- NEEDS HAR CAPTURE TO CONFIRM ---
GET  https://api.depop.com/api/v1/notifications/         ← or per-item likers
GET  https://api.depop.com/api/v1/products/{id}/likes/   ← alternative pattern
POST https://api.depop.com/api/v1/messages/              ← or /conversations/
POST https://api.depop.com/api/v1/offers/                ← or /products/{id}/offers/
```

The existence of all these operations is **confirmed** by commercial products — SellerAider's "Message Recent Likers" and Debob's entire product are built on them.

---

## 2. Authentication

### Web Session (extension bridge path)

The web app stores an access token in the browser post-login (exact cookie name or localStorage key unknown — needs HAR). Requests to `api.depop.com` include this token as an `Authorization` header or cookie. For the extension bridge pattern, the user's live Chrome session handles auth automatically — identical to how the Vinted adapter works. No credentials are ever handled by Haggle code.

### Mobile Auth (reference only — not needed for extension)

Community repos (`Depopped`, `Depop-Python-Interface`) captured the mobile flow via Wireshark:
```
POST /oauth2/access_token
{ username, password, grant_type: "password", client_id, client_secret, idfv }
```
Returns a bearer token. The `client_id`/`client_secret` are hardcoded from old app captures and may be rotated. Not relevant for the extension bridge.

### Token Lifetime

Unknown for the web session token. Likely short-lived (similar to Vinted's 2-hour JWT). The extension pattern handles this gracefully — if the user's browser tab is active, the token is always fresh.

---

## 3. Bot Protection

Depop uses **Cloudflare Bot Management** — not DataDome.

| Factor | Vinted (DataDome) | Depop (Cloudflare) |
|--------|------------------|--------------------|
| Extension bridge bypasses it | ✅ Yes | ✅ Yes |
| Server-side Python requests | ❌ Fails immediately | ❌ Fails most of the time |
| Custom ML model per-site | Yes | No — standard Cloudflare |
| Bypass community resources | Limited | Extensive |

**For the extension bridge, Cloudflare is not a barrier at all.** The `chrome.scripting.executeScript` fetch calls run inside a real Chrome tab with a valid Cloudflare cookie and Chrome's real TLS fingerprint. Existing commercial bots operate at commercial scale on this pattern without systematic blocking.

Depop does have its own account-level enforcement (pattern detection, ML on behaviour). The same mitigations Haggle already uses for Vinted apply: randomised 5–30 min delays, personalised Claude messages (not templates), ≤20 messages/day.

---

## 4. Notifications / Likes

When a buyer likes a listing, the seller receives a notification. Depop does not allow sellers to opt out of like notifications — they are always enabled. This is equivalent to Vinted's `item_liked` notification type.

Two likely patterns for accessing the feed programmatically (both confirmed feasible by existing bots):
1. **Unified notifications feed** — `GET /api/v1/notifications/` (analogous to Vinted's `/api/v2/notifications`)
2. **Per-item likers list** — `GET /api/v1/products/{id}/likes/` (different pattern, requires iterating owned items)

HAR capture will confirm which pattern the web app uses. Either is workable with Haggle's 10-minute polling loop.

---

## 5. Messaging System

Depop uses a conversation-based DM system identical in concept to Vinted's inbox. Buyers and sellers message each other in threaded conversations per item.

All major commercial Depop bots successfully send messages to likers, confirming the messaging POST endpoint is stable. Debob (`debob.co`) is an entire commercial product built on it.

Depop also has a native **Send Offer** feature — sellers can send a discounted price offer to anyone who liked an item (buyers have 24 hours to accept). SellerAider and Vendoo automate this. The offer endpoint also needs HAR capture but is confirmed to exist.

---

## 6. Existing Open-Source Projects

| Repo | Language | Notes |
|------|----------|-------|
| `akimbo7/Depopped` | Python | Mobile auth wrapper; `login()` → bearer token |
| `xjxckk/depop-api-python` | Python | `get_followers()`, `reply_to_messages()` — freshness unknown |
| `githubalt/Depop-Python-Interface` | Python | Built from Wireshark iOS capture; old |
| `scraper-bank/Depop.com-Scrapers` | Python/Node | Read-only listings/search via Playwright |

**Key gap:** Unlike the Vinted ecosystem (where this project has now confirmed working write endpoints from a HAR), no maintained open-source project documents Depop's messaging/notifications endpoints with current auth. Same genuine open-source gap as Vinted had.

---

## 7. Market Context

| Metric | Depop | Vinted |
|--------|-------|--------|
| Registered users | ~43M | 105M+ |
| Active sellers | ~2.5–3M | Not published |
| UK presence | High (founded in London) | Dominant |
| Seller automation tools | SellerAider ($18/mo), Debob, Ceepop | Dotb, Bleam, Vintex |

Depop is ~5–8x smaller than Vinted but still a substantial market. It skews Gen Z / fashion-forward UK sellers — highest overlap with Vinted's seller base.

**eBay acquisition (February 2026):** eBay is acquiring Depop for $1.2B, expected to close Q2 2026. Depop stated to continue as a standalone brand. Risk: API endpoints could be restructured during integration. Likelihood in H1 2026: low. The web UI and internal API are unlikely to change significantly in the near term.

---

## 8. Architecture Fit

### What Is Fully Reusable (Zero New Code)

- `FavouriteEvent` / `Buyer` / `Item` dataclasses — `platform` field already exists
- `event_processor.py`, `claude_service.py`, `rate_limiter.py`
- All DB models and migrations
- `render-client.js`, `deduplicator.js`, `rate-limiter.js`, `storage.js`

### What Needs To Be Added

**Backend (~60 lines):**
```
backend/app/adapters/depop.py   ← parse_favourite_event() for Depop payload shape
```
Update event router to dispatch on `platform: "depop"`.

**Extension (~250 lines):**
```
extension/lib/depop-api.js      ← fetchNotifications, fetchItem, fetchUser,
                                   sendMessage, sendOffer (analogue of vinted-api.js)
```
Update `session.js` to extract Depop's token (once cookie/localStorage key is known from HAR).
Update `service-worker.js` to add Depop polling branch alongside Vinted.

**Manifest:**
```json
"host_permissions": [
  "https://www.vinted.co.uk/*",
  "https://www.depop.com/*",
  "https://api.depop.com/*"
]
```

**Total new code: ~400–500 lines.** The adapter pattern and `platform` field were clearly designed for multi-platform extension.

### Platform Dispatch Strategy

Two options for handling both platforms:

| Option | How it works | Trade-off |
|--------|-------------|-----------|
| **Settings-based** | User selects active platform in popup; extension polls only that one | Simpler, no conflict if both tabs open |
| **Tab-based** | Extension detects whichever platform tab is open and runs the matching adapter | More automatic, slightly more complex |

Settings-based is recommended — simpler and gives the user explicit control.

---

## 9. Key Unknowns & Risk Register

### What Needs HAR Capture Before Building (2–4 hours)

Open DevTools on `depop.com` and capture:
1. **Login** — what cookie/localStorage key holds the access token
2. **Notifications bell** — GET request URL, response schema for a "liked" notification (does it contain `item_id` and `buyer_id` directly, or require following a link?)
3. **Send a message** — POST URL, request body schema
4. **Send an offer to a liker** — POST URL, body, response
5. **Fetch an item** — confirm `GET /api/v1/products/{id}/` shape

### Risk Register

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| Notifications use per-item likers pattern (not unified feed) | Medium | Medium | Both patterns are workable; HAR confirms |
| Auth token in localStorage not cookie | Low | Medium | `executeScript` can read localStorage; small change to session.js |
| eBay integration restructures API before build completes | Medium | Low | HAR verify first, version-pin endpoint URLs |
| Depop tightens enforcement post-acquisition | Medium | Low | Same delay + rate-limit pattern commercial bots already use |
| CORS blocks `fetch()` to `api.depop.com` from within Depop tab | Medium | Very Low | Commercial bots operate this way; would fall back to other injection approach if needed |

---

## 10. Recommended Next Steps

1. **HAR capture spike** (2–4 hours): Same process as the Vinted HAR — browse depop.com, visit notifications, send a message, capture all XHR to `api.depop.com`
2. **Write `depop-api.js`** (~half day): Model on `vinted-api.js`, replace Vinted-specific URLs/schemas
3. **Write `backend/adapters/depop.py`** (~2 hours): Parse Depop notification shape into `FavouriteEvent`
4. **Update `service-worker.js`** (~half day): Add platform selection + Depop polling branch
5. **End-to-end test** on a dedicated Depop test account, max 5 messages/day, 30-min delays

---

*Sources: akimbo7/Depopped, xjxckk/depop-api-python, githubalt/Depop-Python-Interface, Depop Partner API docs (partnerapi.depop.com), SellerAider Depop bot, Debob, The Web Scraping Club #92, Business of Apps Depop Statistics 2026, Vendoo offers guide, eBay-Depop acquisition press release, HackerNoon Depop bots guide.*
