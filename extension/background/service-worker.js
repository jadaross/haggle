/**
 * service-worker.js — Haggle background service worker (MV3).
 *
 * Uses chrome.alarms (not setInterval) because MV3 service workers are killed
 * after ~30 seconds of inactivity. Alarms survive worker termination.
 *
 * Two alarm types:
 *   haggle-poll              — recurring, every 10 minutes, polls Vinted notifications
 *   haggle-send-{notifId}    — one-shot per favourite event, fires after a randomised
 *                              5–30 minute delay (human-like timing)
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
  conversationHasMessages,
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
  // Kick off a first poll right away (will no-op if not enabled / no Vinted tab)
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

// ── Poll: detect new favourites ───────────────────────────────────────────────

async function handlePollAlarm() {
  // Track the latest poll attempt so passive triggers can debounce
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
    const notif = newEvents[i];
    const notifId = String(notif.id);

    // Stub like event so the sidebar shows it immediately as 'queued'
    await upsertLikeEvent(notifId, {
      id: notifId,
      likedAt: notif.updated_at ? new Date(notif.updated_at).getTime() : Date.now(),
      agentStatus: "queued",
      agentReasoning: "",
      buyerHandle: "",
      itemTitle: "Detected favourite",
      itemId: "",
      itemPrice: 0,
    });

    const delayMinutes = alarmDelayMinutes(i);
    chrome.alarms.create(`${SEND_ALARM_PREFIX}${notifId}`, { delayInMinutes: delayMinutes });
    await markAlarmSet(notifId, `${SEND_ALARM_PREFIX}${notifId}`);
    console.log(`[Haggle] Scheduled send for ${notifId} in ${delayMinutes}m.`);
  }

  await broadcastToVintedTabs();
}

// ── Send: generate and (auto) deliver, or queue for approval ──────────────────

async function handleSendAlarm(notifId) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.api_key) return;

  const session = await getSession();
  if (!session.valid) {
    console.warn("[Haggle] Session expired at send time — deferring:", notifId);
    await markFailed(notifId, "session_expired");
    await updateLikeEventStatus(notifId, "skipped", "session expired");
    await broadcastToVintedTabs();
    return;
  }

  const limitCheck = await checkRateLimit(settings.daily_limit);
  if (!limitCheck.allowed) {
    console.warn("[Haggle] Rate limit:", limitCheck.reason, "— skipping:", notifId);
    await markSkipped(notifId, limitCheck.reason);
    await updateLikeEventStatus(notifId, "skipped", limitCheck.reason);
    await broadcastToVintedTabs();
    return;
  }

  // Re-fetch notifications to get the link → itemId / buyerId
  let itemId, buyerId;
  try {
    const notifications = await fetchNotifications(session.token);
    const notif = notifications.find((n) => String(n.id) === notifId);
    if (!notif) {
      await markSkipped(notifId, "notification_not_found");
      await updateLikeEventStatus(notifId, "skipped", "notification expired");
      await broadcastToVintedTabs();
      return;
    }
    ({ itemId, buyerId } = parseFavouriteLink(notif.link));
    if (!itemId) {
      await markSkipped(notifId, "no_item_id");
      await updateLikeEventStatus(notifId, "skipped");
      await broadcastToVintedTabs();
      return;
    }
    if (!buyerId) {
      await markSkipped(notifId, "no_buyer_id");
      await updateLikeEventStatus(notifId, "skipped");
      await broadcastToVintedTabs();
      return;
    }
  } catch (err) {
    console.error("[Haggle] Failed to re-fetch notifications:", err.message);
    await markFailed(notifId, "notification_fetch_error");
    await updateLikeEventStatus(notifId, "skipped", "notification fetch error");
    await broadcastToVintedTabs();
    return;
  }

  // Pull the source notification (re-fetched above) so we can extract a title
  // hint from its body — used as a fallback for fetchItem when Vinted's item
  // endpoints fail. e.g. "arccherry added your Needle & Thread Sequin Floral
  // Maxi Dress UK 10 to their favourites." → "Needle & Thread Sequin..."
  const sourceNotif = (await fetchNotifications(session.token)).find(
    (n) => String(n.id) === notifId,
  );
  const notifBody = sourceNotif?.body || sourceNotif?.title || "";
  const titleHint = extractTitleHint(notifBody);

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
    await broadcastToVintedTabs();
    return;
  }

  const itemPrice = parseFloat(item.price_numeric || item.price);
  const itemTitle = item.title;
  const buyerHandle = buyer.login;

  // Update like event with full details now that we have them
  await upsertLikeEvent(notifId, {
    buyerHandle,
    itemTitle,
    itemId: String(item.id),
    itemPrice,
  });

  // Pre-flight: start (or get existing) conversation so we can detect prior history.
  // Vinted's startConversation is idempotent — returns existing convo if one exists.
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
  } catch (err) {
    console.warn("[Haggle] Pre-flight conversation lookup failed:", err.message);
  }
  const isFollowup = priorMessages.length > 0;

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

  // Generate the message via Render backend
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
        await broadcastToVintedTabs();
        return;
      }
      if (err.code === "duplicate_event") {
        await markSkipped(notifId, "duplicate");
        await updateLikeEventStatus(notifId, "skipped", "duplicate");
        await broadcastToVintedTabs();
        return;
      }
    }
    console.error("[Haggle] Render error:", err.message);
    await markFailed(notifId, "render_error");
    await updateLikeEventStatus(notifId, "skipped", "render error");
    await broadcastToVintedTabs();
    return;
  }

  if (result.status === "duplicate") {
    await markSkipped(notifId, "duplicate");
    await updateLikeEventStatus(notifId, "skipped", "duplicate");
    await broadcastToVintedTabs();
    return;
  }

  const reasoning = result.reasoning || "Generated negotiation message based on buyer & item.";
  await upsertLikeEvent(notifId, { agentReasoning: reasoning });

  // Decide: queue for approval or send directly?
  const mode = settings.mode || "auto";
  const floorPct = settings.globalFloorPct || 75;
  const floorPrice = itemPrice * (floorPct / 100);
  // Heuristic: an agent typically offers up to ~20% off; if that drops below floor, treat as below-floor
  const expectedOffer = itemPrice * 0.80;
  const isBelowFloor = expectedOffer < floorPrice;

  // Decide whether to queue or auto-send:
  //   - follow-ups (existing message history): always queue, regardless of mode
  //   - manual mode: always queue
  //   - threshold mode below floor: queue
  //   - otherwise (auto): send directly
  const shouldQueue = isFollowup
    || mode === "manual"
    || (mode === "threshold" && isBelowFloor);

  if (shouldQueue) {
    await addToPendingQueue({
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
      createdAt: Date.now(),
    });
    await updateLikeEventStatus(notifId, "pending", reasoning);
    console.log(`[Haggle] Queued for approval: ${notifId} (mode=${mode}, followup=${isFollowup}, belowFloor=${isBelowFloor})`);
    await broadcastToVintedTabs();
    return;
  }

  // Auto path: send the message directly via Vinted (no prior history at this point)
  let conversationId = preConversationId;
  try {
    if (!conversationId) {
      const conversation = await startConversation(session.token, itemId, buyerId);
      conversationId = String(conversation.id);
    }
    await sendMessage(session.token, conversationId, result.message_text);
  } catch (err) {
    console.error("[Haggle] Failed to send Vinted message:", err.message);
    await markFailed(notifId, "vinted_send_error");
    await updateLikeEventStatus(notifId, "skipped", "vinted send error");
    await broadcastToVintedTabs();
    return;
  }

  await incrementDailyCount();
  await setLastSendTs();
  await markSent(notifId, result.event_id);
  await updateLikeEventStatus(notifId, "sent", reasoning);

  confirmSent({
    apiKey: settings.api_key,
    eventId: result.event_id,
    vintedConversationId: conversationId,
  }).catch(() => {});

  console.log(`[Haggle] Message sent for item ${itemId} to buyer ${buyerId}.`);
  await broadcastToVintedTabs();
}

// ── Approve / skip handlers (from sidebar) ────────────────────────────────────

async function handleApprovePending(id, messageText) {
  const queue = await getPendingQueue();
  const item = queue.find((i) => i.id === id);
  if (!item) return { ok: false, error: "not_found" };

  const settings = await getSettings();
  const session = await getSession();
  if (!session.valid) return { ok: false, error: "session_expired" };

  const limitCheck = await checkRateLimit(settings.daily_limit);
  if (!limitCheck.allowed) return { ok: false, error: limitCheck.reason };

  let conversationId;
  try {
    const conversation = await startConversation(session.token, item.itemId, item.buyerId);
    conversationId = String(conversation.id);
    // User has explicitly approved — send the message regardless of prior history
    // (this is the follow-up path for queued follow-ups).
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
    // Callback form + explicit lastError read so Chrome doesn't log
    // "Unchecked runtime.lastError" when a tab has no sidebar listener
    // yet (loading) or has been navigated away from.
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
      // Fire-and-forget passive poll — surface fresh notifications when the
      // sidebar mounts. Debounced so rapid page navs don't hammer Vinted.
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
      // Popup pushed a settings change directly to storage; just rebroadcast
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
 * Extract itemId + buyerId from a Vinted notification link.
 *
 * Vinted sends two flavours:
 *   - Mobile deep-link:  vintedfr://messaging?item_id=8294435478&user_id=145161066&portal=fr
 *   - Web URL:           https://www.vinted.co.uk/items/8294435478?offering_id=145161066
 *
 * Both forms expose the IDs in query params; we also fall back to /items/{id}
 * path matching for legacy formats.
 */
/**
 * Extract a likely item title from a Vinted favourite notification body.
 * Bodies look like: "arccherry added your Needle & Thread Sequin... to their favourites."
 * Returns "" if no title could be extracted.
 */
function extractTitleHint(body) {
  if (!body || typeof body !== "string") return "";
  // Pattern: "<user> added your <TITLE> to their favourites."
  const m = body.match(/added your\s+(.+?)\s+to (?:their|your) favourites/i);
  if (m) return m[1].trim();
  return "";
}

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
 * and run the send flow immediately.
 *   - forceQueue=false → behaves like the real alarm (auto mode auto-sends)
 *   - forceQueue=true  → always routes to pending-review queue, no auto-send,
 *                        even on a fresh conversation in auto mode
 */
async function handleDebugForceSend(forceQueue) {
  const settings = await getSettings();
  if (!settings.api_key) return { ok: false, error: "no_api_key" };

  const session = await getSession();
  if (!session.valid) return { ok: false, error: "session_invalid: " + session.reason };

  const notifs = await fetchNotifications(session.token);
  console.log("[Haggle debug] notifs sample:", notifs.slice(0, 3));
  // Pick the first entry_type=20 (favourite) — falling back to any item-linked notif
  const target =
    notifs.find((n) => n.entry_type === 20) ||
    notifs.find((n) => /item_id=|item\?id=|\/items\//.test(n.link || ""));
  if (!target) return { ok: false, error: "no_item_notif_in_response", count: notifs.length };

  const { itemId, buyerId } = parseFavouriteLink(target.link);
  if (!itemId || !buyerId) {
    return { ok: false, error: "link_parse_failed", link: target.link };
  }

  const id = String(target.id);
  // Reset dedup + stub a like event so the sidebar shows it as freshly queued
  await upsertLikeEvent(id, {
    id,
    likedAt: target.updated_at ? new Date(target.updated_at).getTime() : Date.now(),
    agentStatus: "queued",
    agentReasoning: forceQueue ? "(debug force-queue)" : "(debug force-send)",
    buyerHandle: "",
    itemTitle: target.title || target.body || "(debug) favourite",
    itemId: String(itemId),
    itemPrice: 0,
  });
  // Wipe any prior 'sent/skipped/seen' state so handleSendAlarm runs fresh
  const seen = await getSeenEventsForDebug();
  delete seen[id];
  await chrome.storage.local.set({ seen_events: seen });
  await markAlarmSet(id, "(debug)");
  await broadcastToVintedTabs();

  if (forceQueue) {
    // Temporarily flip to manual mode so handleSendAlarm always queues, then restore
    const originalMode = settings.mode || "auto";
    await saveSettings({ mode: "manual" });
    try {
      await handleSendAlarm(id);
    } finally {
      await saveSettings({ mode: originalMode });
      await broadcastToVintedTabs();
    }
  } else {
    await handleSendAlarm(id);
  }
  return { ok: true, picked: { id, itemId, buyerId, link: target.link, forceQueue } };
}

async function getSeenEventsForDebug() {
  const r = await chrome.storage.local.get("seen_events");
  return r.seen_events || {};
}

// Expose debug helpers on the SW global so you can run them directly in the
// chrome://extensions service-worker console:
//   await debugForceQueue()   — runs full pipeline, routes to pending review
//   await debugForceSend()    — runs full pipeline, sends if mode allows
//   await debugClear()        — wipes likes log, pending queue, seen-events,
//                                daily count. Settings (popup toggle / API key /
//                                mode / floor) are preserved.
// (chrome.runtime.sendMessage from inside the SW console fails because the SW
//  doesn't receive its own outbound messages.)
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
  await broadcastToVintedTabs();
  console.log("[Haggle] debug: cleared likes log, pending queue, seen events, counters");
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
