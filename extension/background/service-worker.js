/**
 * service-worker.js — Haggle background service worker (MV3).
 *
 * Uses chrome.alarms (not setInterval) because MV3 service workers are killed
 * after ~30 seconds of inactivity. Alarms survive worker termination.
 *
 * Two alarm types:
 *   haggle-poll              — recurring, every 10 minutes, polls Vinted notifications
 *                              and runs the full generation pipeline for each new
 *                              favourite (item/buyer fetch → backend → Claude).
 *                              Result lands in pendingQueue immediately.
 *   haggle-send-{notifId}    — one-shot per auto-mode favourite, fires after a
 *                              randomised 5–30 minute delay (human-like timing).
 *                              At fire time it just sends the pre-generated
 *                              message; no Claude call.
 */

import { getSession } from "../lib/session.js";
import {
  getSettings,
  saveSettings,
  incrementDailyCount,
  setLastSendTs,
  getDailyCount,
  getPendingQueue,
  addToPendingQueue,
  removePendingItem,
  getLikesLog,
  upsertLikeEvent,
  updateLikeEventStatus,
} from "../lib/storage.js";
import {
  filterNewFavouriteEvents,
  markAlarmSet,
  markFailed,
  markSkipped,
  markSent,
} from "../lib/deduplicator.js";
import {
  fetchNotifications,
  fetchItem,
  fetchUser,
  startConversation,
  sendMessage,
  getConversationMessages,
} from "../lib/vinted-api.js";
import { alarmDelayMinutes, checkRateLimit } from "../lib/rate-limiter.js";
import { postFavouriteEvent, confirmSent, RenderError } from "../lib/render-client.js";

const POLL_ALARM = "haggle-poll";
const POLL_INTERVAL_MINUTES = 10;
const SEND_ALARM_PREFIX = "haggle-send-";
const LAST_POLL_KEY = "last_poll_ts";
const POLL_DEBOUNCE_MS = 30_000; // 30s — used by passive triggers (sidebar mount, popup open)

// ── Startup ───────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await ensurePollAlarm();
  console.log("[Haggle] Installed. Poll alarm registered.");
  handlePollAlarm().catch((e) => console.warn("[Haggle] First poll failed:", e.message));
});

chrome.runtime.onStartup.addListener(async () => {
  await ensurePollAlarm();
  handlePollAlarm().catch((e) => console.warn("[Haggle] Startup poll failed:", e.message));
});

async function ensurePollAlarm() {
  const existing = await chrome.alarms.get(POLL_ALARM);
  if (!existing) {
    chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_INTERVAL_MINUTES });
  }
}

/**
 * Run a poll only if the last poll was longer ago than POLL_DEBOUNCE_MS.
 * Used by passive triggers (sidebar mount, popup open) to avoid hammering Vinted.
 */
async function maybePoll() {
  const r = await chrome.storage.local.get(LAST_POLL_KEY);
  const last = r[LAST_POLL_KEY] || 0;
  if (Date.now() - last < POLL_DEBOUNCE_MS) return false;
  await chrome.storage.local.set({ [LAST_POLL_KEY]: Date.now() });
  await handlePollAlarm();
  return true;
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

// ── Poll: detect new favourites + run full pipeline immediately ───────────────

async function handlePollAlarm() {
  await chrome.storage.local.set({ [LAST_POLL_KEY]: Date.now() });

  const settings = await getSettings();
  if (!settings.enabled || !settings.api_key) return;

  const session = await getSession();
  if (!session.valid) {
    console.warn("[Haggle] Session invalid:", session.reason, "— skipping poll.");
    await setBadge("!", "#b45309");
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
    await processNewFavourite(newEvents[i], settings, session, i);
  }

  await broadcastToVintedTabs();
}

/**
 * Run the full generation pipeline for a single new favourite notification.
 * On the happy path the item lands in pendingQueue immediately — either
 * awaiting user approval (review modes) or scheduled for a delayed auto-send.
 */
async function processNewFavourite(notif, settings, session, index) {
  const notifId = String(notif.id);
  const likedAt = notif.updated_at ? new Date(notif.updated_at).getTime() : Date.now();
  const { itemId, buyerId } = parseFavouriteLink(notif.link);
  const titleHint = extractTitleHint(notif.body || notif.title || "");

  // Render placeholder row right away so the sidebar shows "queued"
  await upsertLikeEvent(notifId, {
    id: notifId,
    likedAt,
    agentStatus: "queued",
    agentReasoning: "",
    buyerHandle: "",
    itemTitle: titleHint || "Detected favourite",
    itemId: itemId || "",
    buyerId: buyerId || "",
    titleHint,
    itemPrice: 0,
  });

  if (!itemId) {
    await markSkipped(notifId, "no_item_id");
    await updateLikeEventStatus(notifId, "skipped");
    return;
  }
  if (!buyerId) {
    await markSkipped(notifId, "no_buyer_id");
    await updateLikeEventStatus(notifId, "skipped");
    return;
  }

  // Server-side rate-limit guard up front, before we burn a Claude call
  const limitCheck = await checkRateLimit(settings.daily_limit);
  if (!limitCheck.allowed) {
    console.warn("[Haggle] Rate limit:", limitCheck.reason, "— skipping:", notifId);
    await markSkipped(notifId, limitCheck.reason);
    await updateLikeEventStatus(notifId, "skipped", limitCheck.reason);
    return;
  }

  // Fetch item + buyer details
  let item, buyer;
  try {
    [item, buyer] = await Promise.all([
      fetchItem(session.token, itemId, titleHint),
      fetchUser(session.token, buyerId),
    ]);
  } catch (err) {
    console.error("[Haggle] Failed to fetch item/buyer:", err.message);
    await markFailed(notifId, "detail_fetch_error");
    await updateLikeEventStatus(notifId, "skipped", "detail fetch error");
    return;
  }

  const itemPrice = parseFloat(item.price_numeric || item.price);
  const itemTitle = item.title;
  const buyerHandle = buyer.login;

  await upsertLikeEvent(notifId, {
    buyerHandle,
    itemTitle,
    itemId: String(item.id),
    itemPrice,
  });

  // Pre-flight conversation: get conversation id + history so we can detect
  // prior messages and skip if the seller has already replied.
  let preConversationId = null;
  let priorMessages = [];
  try {
    const conv = await startConversation(session.token, itemId, buyerId);
    preConversationId = String(conv.id);
    const raw = await getConversationMessages(session.token, preConversationId);
    priorMessages = (raw || []).map((m) => ({
      role: String(m.user_id) === String(buyerId) ? "buyer" : "seller",
      text: (m.body || m.entity?.body || "").trim(),
      sent_at: m.created_at || null,
    })).filter((m) => m.text);
    priorMessages.sort((a, b) => (a.sent_at || "").localeCompare(b.sent_at || ""));
  } catch (err) {
    console.warn("[Haggle] Pre-flight conversation lookup failed:", err.message);
  }

  const isFollowup = priorMessages.length > 0;
  const lastRole = priorMessages[priorMessages.length - 1]?.role;

  // Don't double-message a buyer who hasn't replied yet
  if (lastRole === "seller") {
    console.log("[Haggle] Skipping: seller sent the last message in this thread");
    await markSkipped(notifId, "seller_spoke_last");
    await updateLikeEventStatus(notifId, "skipped", "you already messaged");
    return;
  }

  // Generate the message via Render backend
  const eventPayload = {
    id: notifId,
    detected_at: new Date().toISOString(),
    buyer: {
      id: String(buyer.id),
      username: buyer.login,
      rating: buyer.feedback_reputation,
      item_count: buyer.item_count,
      profile_url: `https://www.vinted.co.uk/member/${buyer.id}`,
    },
    item: {
      id: String(item.id),
      title: item.title,
      price: itemPrice,
      currency: item.currency || "GBP",
      brand: item.brand_title,
      size: item.size_title,
      condition: item.status,
      description: item.description,
      url: item.url,
      photos: (item.photos || []).slice(0, 3).map((p) => p.url || p.full_size_url),
    },
    is_followup: isFollowup,
    previous_messages: priorMessages,
  };

  let result;
  try {
    result = await postFavouriteEvent({
      apiKey: settings.api_key,
      platform: "vinted_uk",
      event: eventPayload,
      sellerConfig: {
        floor_pct: settings.globalFloorPct,
        max_messages_per_day: settings.daily_limit,
      },
    });
  } catch (err) {
    if (err instanceof RenderError) {
      if (err.code === "daily_limit_reached") {
        await markSkipped(notifId, "server_rate_limit");
        await updateLikeEventStatus(notifId, "skipped", "daily limit (server)");
        return;
      }
      if (err.code === "duplicate_event") {
        await markSkipped(notifId, "duplicate");
        await updateLikeEventStatus(notifId, "skipped", "duplicate");
        return;
      }
    }
    console.error("[Haggle] Render error:", err.message);
    await markFailed(notifId, "render_error");
    await updateLikeEventStatus(notifId, "skipped", "render error");
    return;
  }

  if (result.status === "duplicate") {
    await markSkipped(notifId, "duplicate");
    await updateLikeEventStatus(notifId, "skipped", "duplicate");
    return;
  }

  const reasoning = result.reasoning || "Generated negotiation message based on buyer & item.";
  await upsertLikeEvent(notifId, { agentReasoning: reasoning });

  // Mode branching: review (manual / threshold-below-floor / followup) vs auto
  const mode = settings.mode || "auto";
  const floorPct = settings.globalFloorPct || 75;
  const floorPrice = itemPrice * (floorPct / 100);
  const expectedOffer = itemPrice * 0.80;
  const isBelowFloor = expectedOffer < floorPrice;
  const isReview = isFollowup
    || mode === "manual"
    || (mode === "threshold" && isBelowFloor);

  const baseQueueItem = {
    id: notifId,
    buyerHandle,
    buyerId: String(buyer.id),
    itemTitle,
    itemId: String(item.id),
    itemPrice,
    currency: item.currency || "GBP",
    proposedMessage: result.message_text,
    reasoning,
    isBelowFloor: mode === "threshold" && isBelowFloor,
    isFollowup,
    floorPrice,
    eventId: result.event_id,
    vintedConversationId: preConversationId,
    createdAt: Date.now(),
  };

  if (isReview) {
    await addToPendingQueue({ ...baseQueueItem, mode: "review" });
    await markAlarmSet(notifId, "(review)");
    await updateLikeEventStatus(notifId, "pending", reasoning);
    console.log(`[Haggle] Queued for review: ${notifId} (mode=${mode}, followup=${isFollowup}, belowFloor=${isBelowFloor})`);
    return;
  }

  // Auto mode: schedule a randomised send alarm; the message is already generated
  const delayMinutes = alarmDelayMinutes(index);
  const sendAt = Date.now() + delayMinutes * 60_000;
  const alarmName = `${SEND_ALARM_PREFIX}${notifId}`;
  chrome.alarms.create(alarmName, { delayInMinutes: delayMinutes });
  await addToPendingQueue({ ...baseQueueItem, mode: "auto", sendAt, alarmName });
  await markAlarmSet(notifId, alarmName);
  await updateLikeEventStatus(notifId, "pending", reasoning);
  console.log(`[Haggle] Auto-scheduled ${notifId} in ${delayMinutes}m.`);
}

// ── Send: deliver the pre-generated message (auto mode alarm) ─────────────────

async function handleSendAlarm(notifId) {
  const queue = await getPendingQueue();
  const item = queue.find((i) => i.id === notifId);
  if (!item) {
    console.log(`[Haggle] Send alarm fired for ${notifId} but no queue item — already handled.`);
    return;
  }
  if (item.mode !== "auto") {
    console.log(`[Haggle] Send alarm fired for ${notifId} but mode=${item.mode} — leaving in queue.`);
    return;
  }

  const settings = await getSettings();
  if (!settings.enabled || !settings.api_key) return;

  const session = await getSession();
  if (!session.valid) {
    console.warn("[Haggle] Session expired at send time — deferring:", notifId);
    await markFailed(notifId, "session_expired");
    await updateLikeEventStatus(notifId, "skipped", "session expired");
    await removePendingItem(notifId);
    await broadcastToVintedTabs();
    return;
  }

  // Re-check the conversation right before sending. The buyer or seller may
  // have messaged via Vinted's own UI between generation and now.
  let conversationId = item.vintedConversationId || null;
  try {
    if (!conversationId) {
      const conv = await startConversation(session.token, item.itemId, item.buyerId);
      conversationId = String(conv.id);
    }
    const raw = await getConversationMessages(session.token, conversationId);
    const lastRole = lastMessageRole(raw, item.buyerId);
    if (lastRole === "seller") {
      console.log(`[Haggle] Send re-check: seller already messaged — skip ${notifId}`);
      await markSkipped(notifId, "seller_spoke_last");
      await updateLikeEventStatus(notifId, "skipped", "you already messaged");
      await removePendingItem(notifId);
      await broadcastToVintedTabs();
      return;
    }
    if (lastRole === "buyer") {
      // The buyer messaged after we generated — our pre-canned opener is now stale
      console.log(`[Haggle] Send re-check: buyer replied — skip ${notifId}`);
      await markSkipped(notifId, "buyer_replied");
      await updateLikeEventStatus(notifId, "skipped", "buyer replied first");
      await removePendingItem(notifId);
      await broadcastToVintedTabs();
      return;
    }
  } catch (err) {
    console.warn("[Haggle] Send re-check failed; proceeding anyway:", err.message);
  }

  try {
    await sendMessage(session.token, conversationId, item.proposedMessage);
  } catch (err) {
    console.error("[Haggle] Failed to send Vinted message:", err.message);
    await markFailed(notifId, "vinted_send_error");
    await updateLikeEventStatus(notifId, "skipped", "vinted send error");
    await removePendingItem(notifId);
    await broadcastToVintedTabs();
    return;
  }

  await incrementDailyCount();
  await setLastSendTs();
  await markSent(notifId, item.eventId);
  await updateLikeEventStatus(notifId, "sent", item.reasoning);
  await removePendingItem(notifId);

  if (item.eventId && settings.api_key) {
    confirmSent({
      apiKey: settings.api_key,
      eventId: item.eventId,
      vintedConversationId: conversationId,
    }).catch(() => {});
  }

  console.log(`[Haggle] Auto-sent message for item ${item.itemId} to buyer ${item.buyerId}.`);
  await broadcastToVintedTabs();
}

/**
 * Classify the most recent message in a Vinted conversation as "seller" or
 * "buyer" relative to the buyer we're messaging. Returns null on empty input.
 */
function lastMessageRole(rawMessages, buyerId) {
  const msgs = (rawMessages || [])
    .map((m) => ({
      role: String(m.user_id) === String(buyerId) ? "buyer" : "seller",
      text: (m.body || m.entity?.body || "").trim(),
      sent_at: m.created_at || null,
    }))
    .filter((m) => m.text);
  if (msgs.length === 0) return null;
  msgs.sort((a, b) => (a.sent_at || "").localeCompare(b.sent_at || ""));
  return msgs[msgs.length - 1].role;
}

// ── Approve / skip / cancel handlers (from sidebar) ───────────────────────────

async function handleApprovePending(id, messageText) {
  const queue = await getPendingQueue();
  const item = queue.find((i) => i.id === id);
  if (!item) return { ok: false, error: "not_found" };

  const settings = await getSettings();
  const session = await getSession();
  if (!session.valid) return { ok: false, error: "session_expired" };

  const limitCheck = await checkRateLimit(settings.daily_limit);
  if (!limitCheck.allowed) return { ok: false, error: limitCheck.reason };

  // Clear the auto-mode alarm if there is one — user is taking over timing.
  if (item.alarmName) {
    chrome.alarms.clear(item.alarmName).catch(() => {});
  }

  let conversationId = item.vintedConversationId;
  try {
    if (!conversationId) {
      const conversation = await startConversation(session.token, item.itemId, item.buyerId);
      conversationId = String(conversation.id);
    }
    await sendMessage(session.token, conversationId, messageText || item.proposedMessage);
  } catch (err) {
    console.error("[Haggle] Failed to send approved message:", err.message);
    return { ok: false, error: err.message };
  }

  await removePendingItem(id);
  await updateLikeEventStatus(id, "sent", item.reasoning);
  await incrementDailyCount();
  await setLastSendTs();
  await markSent(id, item.eventId);

  if (item.eventId && settings.api_key) {
    confirmSent({
      apiKey: settings.api_key,
      eventId: item.eventId,
      vintedConversationId: conversationId,
    }).catch(() => {});
  }

  await broadcastToVintedTabs();
  return { ok: true };
}

async function handleSkipPending(id) {
  const queue = await getPendingQueue();
  const item = queue.find((i) => i.id === id);
  if (item?.alarmName) {
    chrome.alarms.clear(item.alarmName).catch(() => {});
  }
  await removePendingItem(id);
  await updateLikeEventStatus(id, "skipped", "user skipped");
  await markSkipped(id, "user_skipped");
  await broadcastToVintedTabs();
  return { ok: true };
}

async function handleSaveSettings(settings) {
  const patch = {};
  if (settings.apiKey !== undefined) patch.api_key = settings.apiKey;
  if (settings.globalFloorPct !== undefined) patch.globalFloorPct = settings.globalFloorPct;
  if (settings.dailyLimit !== undefined) patch.daily_limit = settings.dailyLimit;
  if (settings.minDelayMin !== undefined) patch.minDelayMin = settings.minDelayMin;
  if (settings.maxDelayMin !== undefined) patch.maxDelayMin = settings.maxDelayMin;
  if (settings.mode !== undefined) patch.mode = settings.mode;
  if (settings.enabled !== undefined) patch.enabled = settings.enabled;
  await saveSettings(patch);
  await broadcastToVintedTabs();
  return { ok: true };
}

// ── Sidebar state assembly + broadcast ────────────────────────────────────────

async function getSidebarState() {
  const settings = await getSettings();
  const pendingQueue = await getPendingQueue();
  const likesLog = await getLikesLog();
  const sentToday = await getDailyCount();
  return {
    enabled: settings.enabled,
    mode: settings.mode || "auto",
    globalFloorPct: settings.globalFloorPct || 75,
    dailyLimit: settings.daily_limit,
    minDelayMin: settings.minDelayMin || 5,
    maxDelayMin: settings.maxDelayMin || 30,
    apiKey: settings.api_key || "",
    pendingQueue,
    likesLog,
    sentToday,
  };
}

async function broadcastToVintedTabs() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: "https://www.vinted.co.uk/*" });
  } catch {
    return;
  }
  if (!tabs || tabs.length === 0) return;
  const data = await getSidebarState();
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: "sidebar_state_update", data }, () => {
      void chrome.runtime.lastError;
    });
  }
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  switch (message.type) {
    case "poll_now":
      handlePollAlarm()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "get_sidebar_state":
      getSidebarState()
        .then((state) => sendResponse(state))
        .catch(() => sendResponse(null));
      maybePoll()
        .then((ran) => { if (ran) broadcastToVintedTabs(); })
        .catch(() => {});
      return true;

    case "poll_if_stale":
      maybePoll()
        .then((ran) => sendResponse({ ok: true, ran }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "approve_pending":
      handleApprovePending(message.id, message.message)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "skip_pending":
    case "cancel_pending":
      handleSkipPending(message.id)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "save_settings":
      handleSaveSettings(message.settings || {})
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "settings_changed":
      broadcastToVintedTabs().finally(() => sendResponse({ ok: true }));
      return true;

    case "debug_force_send":
      handleDebugForceSend(false)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "debug_force_queue":
      handleDebugForceSend(true)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    default:
      return false;
  }
});

/**
 * Extract a likely item title from a Vinted favourite notification body.
 * "<user> added your <TITLE> to their favourites." → "<TITLE>"
 */
function extractTitleHint(body) {
  if (!body || typeof body !== "string") return "";
  const m = body.match(/added your\s+(.+?)\s+to (?:their|your) favourites/i);
  if (m) return m[1].trim();
  return "";
}

/**
 * Extract itemId + buyerId from a Vinted notification link.
 * Mobile deep-link:  vintedfr://messaging?item_id=X&user_id=Y&portal=fr
 * Web URL:           https://www.vinted.co.uk/items/X?offering_id=Y
 */
function parseFavouriteLink(link) {
  if (!link || typeof link !== "string") return { itemId: null, buyerId: null };
  const qsIdx = link.indexOf("?");
  const params = new URLSearchParams(qsIdx >= 0 ? link.slice(qsIdx + 1) : "");
  let itemId = params.get("item_id") || params.get("id");
  let buyerId = params.get("user_id") || params.get("offering_id");
  if (!itemId) {
    const path = qsIdx >= 0 ? link.slice(0, qsIdx) : link;
    const parts = path.split("/");
    const idx = parts.indexOf("items");
    if (idx >= 0 && parts[idx + 1]) itemId = parts[idx + 1];
  }
  return { itemId: itemId || null, buyerId: buyerId || null };
}

/**
 * Debug-only: pull the first favourite notification from Vinted, bypass dedup,
 * and run the full pipeline.
 *   - forceQueue=false → behaves per current mode
 *   - forceQueue=true  → temporarily forces "manual" mode so the result lands
 *                        in the review queue regardless of user setting
 */
async function handleDebugForceSend(forceQueue) {
  const settings = await getSettings();
  if (!settings.api_key) return { ok: false, error: "no_api_key" };

  const session = await getSession();
  if (!session.valid) return { ok: false, error: "session_invalid: " + session.reason };

  const notifs = await fetchNotifications(session.token);
  console.log("[Haggle debug] notifs sample:", notifs.slice(0, 3));
  const target =
    notifs.find((n) => n.entry_type === 20) ||
    notifs.find((n) => /item_id=|item\?id=|\/items\//.test(n.link || ""));
  if (!target) return { ok: false, error: "no_item_notif_in_response", count: notifs.length };

  const { itemId, buyerId } = parseFavouriteLink(target.link);
  if (!itemId || !buyerId) {
    return { ok: false, error: "link_parse_failed", link: target.link };
  }

  const id = String(target.id);
  // Wipe prior dedup state so the pipeline runs fresh
  const seen = await getSeenEventsForDebug();
  delete seen[id];
  await chrome.storage.local.set({ seen_events: seen });

  if (forceQueue) {
    const originalMode = settings.mode || "auto";
    const overridden = { ...settings, mode: "manual" };
    await processNewFavourite(target, overridden, session, 0);
    // Make sure we don't actually persist the override
    await saveSettings({ mode: originalMode });
  } else {
    await processNewFavourite(target, settings, session, 0);
  }
  await broadcastToVintedTabs();
  return { ok: true, picked: { id, itemId, buyerId, link: target.link, forceQueue } };
}

async function getSeenEventsForDebug() {
  const r = await chrome.storage.local.get("seen_events");
  return r.seen_events || {};
}

// Expose debug helpers on the SW global so you can run them directly in the
// chrome://extensions service-worker console:
//   await debugForceQueue()   — runs full pipeline, routes to review queue
//   await debugForceSend()    — runs full pipeline, respects current mode
//   await debugClear()        — wipes likes log, pending queue, seen-events,
//                                daily count. Settings are preserved.
self.debugForceQueue = () => handleDebugForceSend(true);
self.debugForceSend = () => handleDebugForceSend(false);
self.debugClear = async () => {
  await chrome.storage.local.remove([
    "likes_log",
    "pending_queue",
    "seen_events",
    "daily_count",
    "last_send_ts",
    "last_poll_ts",
  ]);
  // Also clear any still-scheduled send alarms so they don't fire later
  const alarms = await chrome.alarms.getAll();
  for (const a of alarms) {
    if (a.name.startsWith(SEND_ALARM_PREFIX)) await chrome.alarms.clear(a.name);
  }
  await broadcastToVintedTabs();
  console.log("[Haggle] debug: cleared likes log, pending queue, seen events, counters, send alarms");
  return { ok: true };
};

// ── Badge helpers ─────────────────────────────────────────────────────────────

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: "" });
}
