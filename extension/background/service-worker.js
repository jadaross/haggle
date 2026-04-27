/**
 * service-worker.js — Haggle background service worker (MV3).
 *
 * Uses chrome.alarms (not setInterval) because MV3 service workers are killed
 * after ~30 seconds of inactivity. Alarms survive worker termination.
 *
 * Two alarm types:
 *   haggle-poll              — recurring, every 10 minutes, polls Vinted notifications
 *   haggle-send-{notifId}   — one-shot per favourite event, fires after a randomised
 *                              5–30 minute delay (human-like timing)
 */

import { getSession } from "../lib/session.js";
import { getSettings, incrementDailyCount, setLastSendTs } from "../lib/storage.js";
import { filterNewFavouriteEvents, markAlarmSet, markFailed, markSkipped, markSent } from "../lib/deduplicator.js";
import { fetchNotifications, fetchItem, fetchUser, startConversation, sendMessage, conversationHasMessages } from "../lib/vinted-api.js";
import { alarmDelayMinutes, checkRateLimit } from "../lib/rate-limiter.js";
import { postFavouriteEvent, confirmSent, RenderError } from "../lib/render-client.js";

const POLL_ALARM = "haggle-poll";
const POLL_INTERVAL_MINUTES = 10;
const SEND_ALARM_PREFIX = "haggle-send-";

// ── Startup ───────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await ensurePollAlarm();
  console.log("[Haggle] Installed. Poll alarm registered.");
});

chrome.runtime.onStartup.addListener(async () => {
  await ensurePollAlarm();
});

async function ensurePollAlarm() {
  const existing = await chrome.alarms.get(POLL_ALARM);
  if (!existing) {
    chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_INTERVAL_MINUTES });
  }
}

// ── Alarm dispatcher ─────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === POLL_ALARM) {
    await handlePollAlarm();
  } else if (alarm.name.startsWith(SEND_ALARM_PREFIX)) {
    const notifId = alarm.name.slice(SEND_ALARM_PREFIX.length);
    await handleSendAlarm(notifId);
  }
});

// ── Poll: detect new favourites ───────────────────────────────────────────────

async function handlePollAlarm() {
  const settings = await getSettings();
  if (!settings.enabled || !settings.api_key) return;

  const session = await getSession();
  if (!session.valid) {
    console.warn("[Haggle] Session invalid:", session.reason, "— skipping poll.");
    await setBadge("!", "#f59e0b");
    return;
  }

  clearBadge();

  let notifications;
  try {
    notifications = await fetchNotifications(session.token);
  } catch (err) {
    if (err.code === "no_vinted_tab") {
      console.warn("[Haggle] No Vinted tab open — skipping poll.");
    } else {
      console.error("[Haggle] Failed to fetch notifications:", err.message);
    }
    return;
  }

  const newEvents = await filterNewFavouriteEvents(notifications);
  if (newEvents.length === 0) return;

  console.log(`[Haggle] ${newEvents.length} new favourite event(s).`);

  for (let i = 0; i < newEvents.length; i++) {
    const notif = newEvents[i];
    const notifId = String(notif.id);
    const delayMinutes = alarmDelayMinutes(i);

    chrome.alarms.create(`${SEND_ALARM_PREFIX}${notifId}`, {
      delayInMinutes: delayMinutes,
    });

    await markAlarmSet(notifId, `${SEND_ALARM_PREFIX}${notifId}`);
    console.log(`[Haggle] Scheduled send for ${notifId} in ${delayMinutes}m.`);
  }
}

// ── Send: generate and deliver the message ────────────────────────────────────

async function handleSendAlarm(notifId) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.api_key) return;

  // Re-check session — it may have been refreshed since the alarm was set
  const session = await getSession();
  if (!session.valid) {
    console.warn("[Haggle] Session expired at send time — deferring:", notifId);
    await markFailed(notifId, "session_expired");
    return;
  }

  // Client-side rate limit check
  const limitCheck = await checkRateLimit(settings.daily_limit);
  if (!limitCheck.allowed) {
    console.warn("[Haggle] Rate limit:", limitCheck.reason, "— skipping:", notifId);
    await markSkipped(notifId, limitCheck.reason);
    return;
  }

  // Re-fetch notification context — we only stored the notification ID.
  // We need item + buyer details to send to Render.
  // The notification itself contains the IDs; fetch full objects from Vinted.
  let itemId, buyerId;
  try {
    const notifications = await fetchNotifications(session.token);
    const notif = notifications.find((n) => String(n.id) === notifId);
    if (!notif) {
      // Notification has scrolled out of the feed — skip
      await markSkipped(notifId, "notification_not_found");
      return;
    }
    // Item ID: extract from link path "/items/{id}/..."
    // (new API no longer has subject_id)
    const linkPath = (notif.link || "").split("?")[0];
    const linkParts = linkPath.split("/");
    const itemsIdx = linkParts.indexOf("items");
    itemId = itemsIdx >= 0 ? linkParts[itemsIdx + 1] : null;
    if (!itemId) {
      await markSkipped(notifId, "no_item_id");
      return;
    }
    // Buyer user ID is the offering_id query param in the link
    // link format: "/items/{item_id}/want_it/new?offering_id={buyer_user_id}"
    const linkParams = new URLSearchParams((notif.link || "").split("?")[1] || "");
    buyerId = linkParams.get("offering_id");
    if (!buyerId) {
      await markSkipped(notifId, "no_buyer_id");
      return;
    }
  } catch (err) {
    console.error("[Haggle] Failed to re-fetch notifications:", err.message);
    await markFailed(notifId, "notification_fetch_error");
    return;
  }

  // Fetch item and buyer details
  let item, buyer;
  try {
    [item, buyer] = await Promise.all([
      fetchItem(session.token, itemId),
      fetchUser(session.token, buyerId),
    ]);
  } catch (err) {
    console.error("[Haggle] Failed to fetch item/buyer:", err.message);
    await markFailed(notifId, "detail_fetch_error");
    return;
  }

  // Build the event payload for the backend
  const eventPayload = {
    id: notifId,
    detected_at: new Date().toISOString(),
    buyer: {
      id: buyer.id,
      username: buyer.login,
      rating: buyer.feedback_reputation,
      item_count: buyer.item_count,
      profile_url: `https://www.vinted.co.uk/member/${buyer.id}`,
    },
    item: {
      id: item.id,
      title: item.title,
      price: parseFloat(item.price_numeric || item.price),
      currency: item.currency || "GBP",
      brand: item.brand_title,
      size: item.size_title,
      condition: item.status,
      description: item.description,
      url: item.url,
      photos: (item.photos || []).slice(0, 3).map((p) => p.url || p.full_size_url),
    },
  };

  // POST to Render — get message text back
  let result;
  try {
    result = await postFavouriteEvent({
      apiKey: settings.api_key,
      platform: "vinted_uk",
      event: eventPayload,
      sellerConfig: {
        floor_pct: settings.floor_pct,
        max_messages_per_day: settings.daily_limit,
      },
    });
  } catch (err) {
    if (err instanceof RenderError) {
      if (err.code === "daily_limit_reached") {
        await markSkipped(notifId, "server_rate_limit");
        return;
      }
      if (err.code === "duplicate_event") {
        await markSkipped(notifId, "duplicate");
        return;
      }
    }
    console.error("[Haggle] Render error:", err.message);
    await markFailed(notifId, "render_error");
    return;
  }

  if (result.status === "duplicate") {
    await markSkipped(notifId, "duplicate");
    return;
  }

  // Send the message via Vinted — using the user's live session
  let conversationId;
  try {
    const conversation = await startConversation(session.token, itemId, buyerId);
    conversationId = String(conversation.id);

    // Skip if we've already exchanged messages in this conversation
    const alreadyMessaged = await conversationHasMessages(session.token, conversationId);
    if (alreadyMessaged) {
      console.log(`[Haggle] Conversation ${conversationId} already has messages — skipping.`);
      await markSkipped(notifId, "already_messaged");
      return;
    }

    await sendMessage(session.token, conversationId, result.message_text);
  } catch (err) {
    console.error("[Haggle] Failed to send Vinted message:", err.message);
    await markFailed(notifId, "vinted_send_error");
    return;
  }

  // Update local state
  await incrementDailyCount();
  await setLastSendTs();
  await markSent(notifId, result.event_id);

  // Fire-and-forget confirmation to backend
  await confirmSent({
    apiKey: settings.api_key,
    eventId: result.event_id,
    vintedConversationId: conversationId,
  });

  console.log(`[Haggle] Message sent for item ${itemId} to buyer ${buyerId}.`);
}

// ── Manual trigger (from popup "Poll now" button) ─────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "poll_now") {
    handlePollAlarm()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true; // keep channel open for async response
  }
});

// ── Badge helpers ─────────────────────────────────────────────────────────────

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: "" });
}
