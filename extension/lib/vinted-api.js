/**
 * vinted-api.js — Thin wrapper around Vinted's internal API.
 *
 * All requests run inside an open Vinted tab via chrome.scripting.executeScript
 * so that session cookies are included automatically (same-site).
 * No Bearer token or CSRF token is needed from this context.
 */

const WWW_BASE = "https://www.vinted.co.uk/api/v2";
const NOTIF_BASE = "https://api.vinted.co.uk/inbox-notifications/v1";

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

  if (!result.ok) {
    const err = new Error(`Vinted API → ${result.status}`);
    err.status = result.status;
    throw err;
  }
  return result.data;
}

/**
 * Poll notification feed for item_liked events.
 * Returns the raw notifications array.
 */
export async function fetchNotifications(_token) {
  return executeInVintedTab(async (base) => {
    try {
      const res = await fetch(`${base}/notifications?page=1&per_page=20`, {
        credentials: "include",
        headers: {
          "accept": "application/json, text/plain, */*",
          "locale": "en-GB",
          "platform": "web",
          "x-next-app": "marketplace-web",
        },
      });
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      return { ok: true, data: data.notifications || [] };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  }, [WWW_BASE]);
}

/**
 * Fetch item details by ID.
 */
export async function fetchItem(token, itemId) {
  return executeInVintedTab(async (base, id, tok) => {
    try {
      const res = await fetch(`${base}/items/${id}`, {
        credentials: "include",
        headers: { "accept": "application/json", "locale": "en-GB", "platform": "web", "x-next-app": "marketplace-web", "Authorization": `Bearer ${tok}` },
      });
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      return { ok: true, data: data.item };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  }, [WWW_BASE, itemId, token]);
}

/**
 * Fetch user profile by ID.
 */
export async function fetchUser(token, userId) {
  return executeInVintedTab(async (base, id, tok) => {
    try {
      const res = await fetch(`${base}/users/${id}`, {
        credentials: "include",
        headers: { "accept": "application/json", "locale": "en-GB", "platform": "web", "x-next-app": "marketplace-web", "Authorization": `Bearer ${tok}` },
      });
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      return { ok: true, data: data.user };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  }, [WWW_BASE, userId, token]);
}

/**
 * Start a new conversation with a buyer about an item.
 * Returns the conversation object.
 */
export async function startConversation(_token, itemId, buyerId) {
  return executeInVintedTab(async (base, iId, bId) => {
    try {
      const res = await fetch(`${base}/conversations`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initiator: "seller_enters_notification", item_id: iId, opposite_user_id: bId }),
      });
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      return { ok: true, data: data.conversation };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  }, [WWW_BASE, itemId, buyerId]);
}

/**
 * Returns true if the conversation already has any messages.
 * Used to avoid re-messaging buyers we've already spoken to.
 */
export async function conversationHasMessages(_token, conversationId) {
  return executeInVintedTab(async (base, convId) => {
    try {
      const res = await fetch(`${base}/conversations/${convId}/messages`, { credentials: "include" });
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      return { ok: true, data: (data.messages || []).length > 0 };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  }, [WWW_BASE, conversationId]);
}

/**
 * Send a message into an existing conversation.
 */
export async function sendMessage(_token, conversationId, messageText) {
  return executeInVintedTab(async (base, convId, text) => {
    try {
      const res = await fetch(`${base}/conversations/${convId}/replies`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reply: { body: text, photo_temp_uuids: null, is_personal_data_sharing_check_skipped: false } }),
      });
      if (!res.ok) return { ok: false, status: res.status };
      const data = await res.json();
      return { ok: true, data };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  }, [WWW_BASE, conversationId, messageText]);
}
