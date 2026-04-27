---
name: Project Haggle context
description: What haggle is, its design decisions, and the key unknowns to resolve first
type: project
---

Haggle is an open-source AI agent that automates selling on Vinted (vinted.co.uk). It detects when someone favourites a listing, then uses Claude (claude-sonnet-4-6) to generate personalised negotiation messages and send them via Vinted's API.

**Why:** Genuine open-source gap — no maintained headless seller automation exists. LLM-generated messages (not templates) is the differentiator over Dotb/Bleam (€0-25/mo commercial tools).

**Target stack:** Python, Railway, PostgreSQL, Claude API.

**Critical architecture gate (not yet resolved):** Mobile API write operations (send message, make offer) need to be verified via mitmproxy on the Vinted iOS app before committing to headless design. If mobile API write ops work → server-side bot (no DataDome). If not → extension bridge pattern (extension relays to Railway agent).

**Key findings:**
- DataDome actively protects web API; mobile API bypasses it
- No open-source project has published working message/offer endpoints
- Web access_token_web expires every ~2 hours; mobile token lifetime unknown
- January 2026: Vinted added perceptual hash detection for relisted images
- Favourite-to-message conversion is #1 seller demand, 3x purchase likelihood if messaged within 24h

**How to apply:** Always check whether the mitmproxy spike has been completed before suggesting web-API-based architecture. Recommended delays: 5-30 min after favourite event, max ~20 messages/day.
