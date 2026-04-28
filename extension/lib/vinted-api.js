/**
 * vinted-api.js — Thin wrapper around Vinted's web API.
 *
 * Auth model (matches what the HAR shows Vinted's frontend doing):
 *   - x-csrf-token: captured from the main-world fetch trap (DOM attr)
 *   - x-anon-id:    read from the JS-readable `anon_id` cookie
 *   - cookies:      browser includes session cookies automatically (credentials:include)
 *
 * Item & user details are NOT fetched via API — those endpoints reject
 * extension calls. We scrape the page's __NEXT_DATA__ JSON instead.
 */

async function executeInVintedTab(func, args = []) {
  const tabs = await chrome.tabs.query({ url: "https://www.vinted.co.uk/*" });
  if (tabs.length === 0) {
    const err = new Error("No Vinted tab open — open vinted.co.uk to enable Haggle");
    err.code = "no_vinted_tab";
    throw err;
  }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tabs[0].id },
    func,
    args,
  });
  if (!result || !result.ok) {
    const status = result ? result.status : "unknown";
    const err = new Error(`Vinted API → ${status}${result?.error ? ` (${result.error})` : ""}`);
    err.status = status;
    err.detail = result?.error;
    throw err;
  }
  return result.data;
}

// ── Page-side helper builders (run in the isolated world inside the Vinted tab) ──

// We can't import across the executeScript boundary, so each injected function
// inlines the same auth-header builder. The factory below is stringified at
// build time of each call.

function injectedHeadersBuilder() {
  // This function is serialised + injected — must be self-contained.
  const csrf = document.documentElement.getAttribute("data-haggle-csrf") || "";
  const anonMatch = document.cookie.match(/(?:^|;\s*)anon_id=([^;]+)/);
  const anonId = anonMatch ? anonMatch[1] : "";
  const headers = {
    "accept": "application/json, text/plain, */*",
    "locale": "en-GB",
    "x-money-object": "true",
  };
  if (csrf) headers["x-csrf-token"] = csrf;
  if (anonId) headers["x-anon-id"] = anonId;
  return { headers, csrf, anonId };
}

// ── Notifications ────────────────────────────────────────────────────────────

export async function fetchNotifications(_token) {
  return executeInVintedTab(async () => {
    const csrf = document.documentElement.getAttribute("data-haggle-csrf") || "";
    const anonMatch = document.cookie.match(/(?:^|;\s*)anon_id=([^;]+)/);
    const anonId = anonMatch ? anonMatch[1] : "";
    const headers = {
      "accept": "application/json, text/plain, */*",
      "locale": "en-GB",
      "x-money-object": "true",
    };
    if (csrf) headers["x-csrf-token"] = csrf;
    if (anonId) headers["x-anon-id"] = anonId;

    if (!csrf) {
      console.warn("[Haggle] CSRF not yet captured — refresh the Vinted page once");
    }

    // Vinted has multiple notification endpoints. Try them all.
    const candidates = [
      "https://www.vinted.co.uk/api/v2/notifications?page=1&per_page=20",
      "https://api.vinted.co.uk/inbox-notifications/v1/notifications?page=1&per_page=20",
      "https://www.vinted.co.uk/api/v2/inbox-notifications?page=1&per_page=20",
      "https://api.vinted.co.uk/inbox-notifications/v1/inbox-notifications?page=1&per_page=20",
      "https://www.vinted.co.uk/api/v2/inbox?page=1&per_page=20",
    ];
    let lastStatus = 0;
    for (const url of candidates) {
      try {
        const res = await fetch(url, { credentials: "include", headers });
        if (res.ok) {
          const data = await res.json();
          const notifs = data.notifications || data.items || data.data || [];
          console.log("[Haggle] notifications endpoint OK:", url, "→", notifs.length, "items");
          return { ok: true, data: notifs };
        }
        lastStatus = res.status;
      } catch (_) { /* next */ }
    }
    return { ok: false, status: lastStatus || 404, error: "all notification endpoints failed (csrf=" + (csrf ? "yes" : "no") + ")" };
  }, []);
}

// ── Item details ─────────────────────────────────────────────────────────────
// Try the JSON API first (faster, structured), fall back to HTML scrape.

/**
 * Walk Vinted's RSC chunks (self.__next_f.push([1, "<json-string>"])) and
 * search every embedded JSON for an item-shaped node matching `wantedId`.
 *
 * RSC payloads are JSON strings inside JSON strings (escaped twice). The
 * cleanest tactic is to parse each chunk, then scan the resulting tree for
 * any object that has the expected item fields.
 *
 * Runs inside the page context (executeScript) — must be self-contained.
 */
function extractItemFromRSC(matches, wantedId) {
  function findItem(node, depth = 0) {
    if (!node || depth > 30) return null;
    if (typeof node === "object") {
      if (Array.isArray(node)) {
        for (const child of node) {
          const hit = findItem(child, depth + 1);
          if (hit) return hit;
        }
        return null;
      }
      // Plausible item shape: has id matching ours + title/price fields
      const idMatch = String(node.id) === wantedId || String(node.item_id) === wantedId;
      const looksLikeItem =
        idMatch &&
        (node.title || node.brand || node.brand_title) &&
        (node.price || node.price_numeric);
      if (looksLikeItem) return node;
      for (const v of Object.values(node)) {
        const hit = findItem(v, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  for (const m of matches) {
    let raw = m[1];
    // raw is a JSON-encoded string starting with `"...`. Parse to get the
    // inner string, which itself is RSC-formatted (often `"<rowid>:<json>"`).
    let inner;
    try { inner = JSON.parse(raw); } catch { continue; }
    if (typeof inner !== "string") continue;
    // RSC rows look like "1:I[...]" or "2:[...]" or just JSON. Try to find
    // a JSON array/object after the prefix and parse it.
    const colon = inner.indexOf(":");
    const candidates = [
      inner,
      colon >= 0 ? inner.slice(colon + 1) : "",
    ];
    for (const c of candidates) {
      const trimmed = c.trim();
      if (!(trimmed.startsWith("[") || trimmed.startsWith("{"))) continue;
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch { continue; }
      const hit = findItem(parsed);
      if (hit) return hit;
    }
  }
  return null;
}

export async function fetchItem(_token, itemId, hintTitle) {
  return executeInVintedTab(async (id, titleHint) => {
    const csrf = document.documentElement.getAttribute("data-haggle-csrf") || "";
    const anonMatch = document.cookie.match(/(?:^|;\s*)anon_id=([^;]+)/);
    const anonId = anonMatch ? anonMatch[1] : "";
    const headers = {
      "accept": "application/json, text/plain, */*",
      "locale": "en-GB",
      "x-money-object": "true",
    };
    if (csrf) headers["x-csrf-token"] = csrf;
    if (anonId) headers["x-anon-id"] = anonId;

    // 1. Try multiple JSON API endpoints. Vinted has reshuffled the items
    //    namespace several times — the bare /items/{id} returns 404 in some
    //    regions while /items/{id}/details and /items/{id}/info still work.
    const apiCandidates = [
      `https://www.vinted.co.uk/api/v2/items/${id}/details`,
      `https://www.vinted.co.uk/api/v2/items/${id}`,
      `https://www.vinted.co.uk/api/v2/items/${id}/info`,
      `https://api.vinted.co.uk/api/v2/items/${id}`,
    ];
    for (const url of apiCandidates) {
      try {
        const res = await fetch(url, { credentials: "include", headers });
        if (res.ok) {
          const data = await res.json();
          const item = data.item || data;
          if (item && item.id) {
            console.log("[Haggle] item via API:", url, "→", item.id, item.title);
            return { ok: true, data: item };
          }
        } else {
          console.warn("[Haggle] item API", url, "→", res.status);
        }
      } catch (e) {
        console.warn("[Haggle] item API threw on", url, ":", e.message);
      }
    }
    console.warn("[Haggle] all item APIs failed — falling back to HTML scrape");

    // 2. Fallback: HTML scrape — supports both legacy Pages Router (__NEXT_DATA__)
    //    and the new App Router with RSC payloads (self.__next_f.push chunks).
    //    Each branch returns the item on success; failure falls through to the stub.
    try {
      const res = await fetch(`https://www.vinted.co.uk/items/${id}`, { credentials: "include" });
      if (!res.ok) {
        console.warn("[Haggle] item HTML page fetch failed:", res.status);
        throw new Error("page_fetch_" + res.status);
      }
      const html = await res.text();

      // 2a. Pages Router: <script id="__NEXT_DATA__">{...}</script>
      const legacyMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (legacyMatch) {
        const data = JSON.parse(legacyMatch[1]);
        const pp = data?.props?.pageProps || {};
        const item =
          pp.item ||
          pp.itemDto ||
          pp.itemPageData?.item ||
          pp.dehydratedState?.queries?.find?.((q) => /item/i.test(JSON.stringify(q.queryKey)))?.state?.data?.item ||
          null;
        if (item) {
          console.log("[Haggle] item via __NEXT_DATA__:", item.id, item.title);
          return { ok: true, data: item };
        }
      }

      // 2b. App Router (RSC): self.__next_f.push([1, "..."]) — concatenate the
      //     payloads, decode the embedded JSON-string fragments, and search for
      //     a node with our item shape (id + title + price).
      const rscChunks = [...html.matchAll(/self\.__next_f\.push\(\[\d+,(.+?)\]\)<\/script>/g)];
      if (rscChunks.length > 0) {
        const item = extractItemFromRSC(rscChunks, String(id));
        if (item) {
          console.log("[Haggle] item via RSC scrape:", item.id, item.title);
          return { ok: true, data: item };
        }
        console.warn("[Haggle] RSC chunks present but item shape not found (chunks=" + rscChunks.length + ")");
      } else {
        console.warn("[Haggle] no __NEXT_DATA__ and no __next_f chunks. HTML head:", html.slice(0, 500));
      }
    } catch (e) {
      console.warn("[Haggle] item HTML scrape threw:", e.message);
    }

    // 3. Last-resort stub: lets the pipeline keep running so the user can test
    //    the backend → review flow even when Vinted's item endpoints all fail.
    //    We use the title hint from the notification body when available.
    console.warn("[Haggle] item fetch fully failed — returning stub for id", id);
    return {
      ok: true,
      data: {
        id,
        title: titleHint || `Item ${id}`,
        price: 0,
        price_numeric: 0,
        currency: "GBP",
        brand_title: null,
        size_title: null,
        status: null,
        description: "",
        url: `https://www.vinted.co.uk/items/${id}`,
        photos: [],
      },
    };
  }, [itemId, hintTitle || ""]);
}

// ── User details ─────────────────────────────────────────────────────────────
// Try the JSON API first (faster, structured), fall back to HTML scrape, then
// to a stub object so the pipeline can still proceed with at least the user id.

export async function fetchUser(_token, userId) {
  return executeInVintedTab(async (id) => {
    const csrf = document.documentElement.getAttribute("data-haggle-csrf") || "";
    const anonMatch = document.cookie.match(/(?:^|;\s*)anon_id=([^;]+)/);
    const anonId = anonMatch ? anonMatch[1] : "";
    const headers = {
      "accept": "application/json, text/plain, */*",
      "locale": "en-GB",
      "x-money-object": "true",
    };
    if (csrf) headers["x-csrf-token"] = csrf;
    if (anonId) headers["x-anon-id"] = anonId;

    // 1. Try JSON API
    try {
      const res = await fetch(`https://www.vinted.co.uk/api/v2/users/${id}`, {
        credentials: "include",
        headers,
      });
      if (res.ok) {
        const data = await res.json();
        const user = data.user || data;
        if (user && user.id) {
          console.log("[Haggle] user via API:", user.id, user.login);
          return { ok: true, data: user };
        }
      } else {
        console.warn("[Haggle] user API failed:", res.status, "— falling back to HTML scrape");
      }
    } catch (e) {
      console.warn("[Haggle] user API threw:", e.message, "— falling back");
    }

    // 2. Fallback: HTML scrape
    try {
      const res = await fetch(`https://www.vinted.co.uk/member/${id}`, { credentials: "include" });
      if (res.ok) {
        const html = await res.text();
        const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (m) {
          let data;
          try { data = JSON.parse(m[1]); } catch (_) { data = null; }
          const pp = data?.props?.pageProps || {};
          let user = pp.user || pp.member || pp.userDto || null;
          if (!user) {
            const queries = pp.dehydratedState?.queries || [];
            for (const q of queries) {
              const d = q?.state?.data;
              if (d && d.user && d.user.id) { user = d.user; break; }
              if (d && d.id && d.login) { user = d; break; }
            }
          }
          if (user) {
            console.log("[Haggle] user via HTML scrape:", user.id, user.login);
            return { ok: true, data: user };
          }
        }
      }
    } catch (_) { /* fall through to stub */ }

    // 3. Last-resort stub: pipeline can still run with just the id.
    console.warn("[Haggle] user fetch fully failed — returning stub for id", id);
    return {
      ok: true,
      data: { id, login: `user_${id}`, feedback_reputation: null, item_count: null },
    };
  }, [userId]);
}

// ── Conversations ────────────────────────────────────────────────────────────

export async function startConversation(_token, itemId, buyerId) {
  return executeInVintedTab(async (iId, bId) => {
    const csrf = document.documentElement.getAttribute("data-haggle-csrf") || "";
    const anonMatch = document.cookie.match(/(?:^|;\s*)anon_id=([^;]+)/);
    const anonId = anonMatch ? anonMatch[1] : "";
    const headers = {
      "accept": "application/json, text/plain, */*",
      "content-type": "application/json",
      "locale": "en-GB",
      "x-money-object": "true",
    };
    if (csrf) headers["x-csrf-token"] = csrf;
    if (anonId) headers["x-anon-id"] = anonId;

    try {
      const res = await fetch("https://www.vinted.co.uk/api/v2/conversations", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          initiator: "seller_enters_notification",
          item_id: String(iId),
          opposite_user_id: String(bId),
        }),
      });
      if (!res.ok) return { ok: false, status: res.status, error: "startConversation failed" };
      const data = await res.json();
      return { ok: true, data: data.conversation || data };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  }, [itemId, buyerId]);
}

export async function conversationHasMessages(_token, conversationId) {
  return executeInVintedTab(async (convId) => {
    const csrf = document.documentElement.getAttribute("data-haggle-csrf") || "";
    const anonMatch = document.cookie.match(/(?:^|;\s*)anon_id=([^;]+)/);
    const anonId = anonMatch ? anonMatch[1] : "";
    const headers = { "accept": "application/json", "locale": "en-GB", "x-money-object": "true" };
    if (csrf) headers["x-csrf-token"] = csrf;
    if (anonId) headers["x-anon-id"] = anonId;

    try {
      const res = await fetch(`https://www.vinted.co.uk/api/v2/conversations/${convId}`, {
        credentials: "include",
        headers,
      });
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      const messages = data.conversation?.messages || data.messages || [];
      return { ok: true, data: messages.length > 0 };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  }, [conversationId]);
}

export async function getConversationMessages(_token, conversationId) {
  return executeInVintedTab(async (convId) => {
    const csrf = document.documentElement.getAttribute("data-haggle-csrf") || "";
    const anonMatch = document.cookie.match(/(?:^|;\s*)anon_id=([^;]+)/);
    const anonId = anonMatch ? anonMatch[1] : "";
    const headers = { "accept": "application/json", "locale": "en-GB", "x-money-object": "true" };
    if (csrf) headers["x-csrf-token"] = csrf;
    if (anonId) headers["x-anon-id"] = anonId;

    try {
      const res = await fetch(`https://www.vinted.co.uk/api/v2/conversations/${convId}`, {
        credentials: "include",
        headers,
      });
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      const messages = data.conversation?.messages || data.messages || [];
      return { ok: true, data: messages };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  }, [conversationId]);
}

export async function sendMessage(_token, conversationId, messageText) {
  return executeInVintedTab(async (convId, text) => {
    const csrf = document.documentElement.getAttribute("data-haggle-csrf") || "";
    const anonMatch = document.cookie.match(/(?:^|;\s*)anon_id=([^;]+)/);
    const anonId = anonMatch ? anonMatch[1] : "";
    const headers = {
      "accept": "application/json, text/plain, */*",
      "content-type": "application/json",
      "locale": "en-GB",
      "x-money-object": "true",
    };
    if (csrf) headers["x-csrf-token"] = csrf;
    if (anonId) headers["x-anon-id"] = anonId;

    try {
      const res = await fetch(`https://www.vinted.co.uk/api/v2/conversations/${convId}/replies`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          reply: { body: text, photo_temp_uuids: null, is_personal_data_sharing_check_skipped: false },
        }),
      });
      if (!res.ok) return { ok: false, status: res.status, error: "sendMessage failed" };
      const data = await res.json();
      return { ok: true, data };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  }, [conversationId, messageText]);
}
