/**
 * render-client.js — HTTP client for the Haggle Render backend.
 */

// Set at build/deploy time. Switch to "http://127.0.0.1:8000" for local dev.
const RENDER_BASE = "https://haggle-api.onrender.com";

/**
 * POST a favourite event to the backend.
 * Returns { event_id, message_id, message_text, status } on success.
 * Throws a RenderError on non-2xx responses.
 */
export async function postFavouriteEvent({ apiKey, platform, event, sellerConfig }) {
  const res = await fetch(`${RENDER_BASE}/events/favourite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      platform,
      event,
      seller_config: sellerConfig,
    }),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new RenderError(res.status, body?.detail?.error || "unknown_error", body?.detail?.detail);
    throw err;
  }

  return body;
}

/**
 * Confirm to the backend that the extension successfully sent the message.
 */
export async function confirmSent({ apiKey, eventId, vintedConversationId }) {
  await fetch(`${RENDER_BASE}/events/${eventId}/sent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      vinted_conversation_id: vintedConversationId,
      sent_at: new Date().toISOString(),
    }),
  });
  // Fire-and-forget — don't block the send flow on confirmation
}

/**
 * Fetch today's stats for the popup status line.
 */
export async function fetchStats({ apiKey, dailyLimit }) {
  const url = new URL(`${RENDER_BASE}/stats`);
  url.searchParams.set("daily_limit", String(dailyLimit));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return null;
  return res.json();
}

export class RenderError extends Error {
  constructor(status, code, detail) {
    super(detail || code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
