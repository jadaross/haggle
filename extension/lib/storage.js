/**
 * storage.js — Typed wrappers around chrome.storage.
 *
 * Settings (synced across devices): chrome.storage.sync
 * Runtime state (local only):       chrome.storage.local
 */

// ── Settings (chrome.storage.sync) ───────────────────────────────────────────

const SYNC_DEFAULTS_FETCH = {
  enabled: false,
  api_key: "",
  daily_limit: 20,
  mode: "auto",
  minDelayMin: 5,
  maxDelayMin: 30,
  // Use null sentinels for keys that need migration logic so we can detect "unset"
  globalFloorPct: null,
  floor_pct: null,
};

export async function getSettings() {
  const result = await chrome.storage.sync.get(SYNC_DEFAULTS_FETCH);
  // Migrate legacy floor_pct → globalFloorPct
  if (result.globalFloorPct == null) {
    result.globalFloorPct = result.floor_pct != null ? result.floor_pct : 75;
  }
  delete result.floor_pct;
  return result;
}

export async function saveSettings(patch) {
  await chrome.storage.sync.set(patch);
}

// ── Seen events (chrome.storage.local) ───────────────────────────────────────

const SEEN_EVENTS_KEY = "seen_events";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function getSeenEvents() {
  const result = await chrome.storage.local.get(SEEN_EVENTS_KEY);
  return result[SEEN_EVENTS_KEY] || {};
}

export async function markEventSeen(notificationId, status, extra = {}) {
  const seen = await getSeenEvents();
  seen[notificationId] = { status, ts: Date.now(), ...extra };
  await chrome.storage.local.set({ [SEEN_EVENTS_KEY]: seen });
}

export async function isEventSeen(notificationId) {
  const seen = await getSeenEvents();
  return notificationId in seen;
}

export async function pruneSeenEvents() {
  const seen = await getSeenEvents();
  const cutoff = Date.now() - MAX_AGE_MS;
  const pruned = Object.fromEntries(
    Object.entries(seen).filter(([, v]) => v.ts > cutoff)
  );
  await chrome.storage.local.set({ [SEEN_EVENTS_KEY]: pruned });
}

// ── Daily counter (chrome.storage.local) ─────────────────────────────────────

const DAILY_COUNT_KEY = "daily_count";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export async function getDailyCount() {
  const result = await chrome.storage.local.get(DAILY_COUNT_KEY);
  const stored = result[DAILY_COUNT_KEY];
  if (!stored || stored.date !== todayStr()) return 0;
  return stored.count;
}

export async function incrementDailyCount() {
  const count = await getDailyCount();
  await chrome.storage.local.set({
    [DAILY_COUNT_KEY]: { date: todayStr(), count: count + 1 },
  });
}

// ── Last send time ────────────────────────────────────────────────────────────

const LAST_SEND_KEY = "last_send_ts";

export async function getLastSendTs() {
  const result = await chrome.storage.local.get(LAST_SEND_KEY);
  return result[LAST_SEND_KEY] || 0;
}

export async function setLastSendTs(ts = Date.now()) {
  await chrome.storage.local.set({ [LAST_SEND_KEY]: ts });
}

// ── Pending queue (chrome.storage.local) ─────────────────────────────────────

const PENDING_QUEUE_KEY = "pending_queue";

export async function getPendingQueue() {
  const r = await chrome.storage.local.get(PENDING_QUEUE_KEY);
  return r[PENDING_QUEUE_KEY] || [];
}

export async function addToPendingQueue(item) {
  const queue = await getPendingQueue();
  if (queue.find((i) => i.id === item.id)) return;
  queue.push(item);
  await chrome.storage.local.set({ [PENDING_QUEUE_KEY]: queue });
}

export async function removePendingItem(id) {
  const queue = await getPendingQueue();
  await chrome.storage.local.set({
    [PENDING_QUEUE_KEY]: queue.filter((i) => i.id !== id),
  });
}

// ── Likes log (chrome.storage.local) ─────────────────────────────────────────

const LIKES_LOG_KEY = "likes_log";
const MAX_LIKES_LOG = 200;

export async function getLikesLog() {
  const r = await chrome.storage.local.get(LIKES_LOG_KEY);
  return r[LIKES_LOG_KEY] || [];
}

export async function upsertLikeEvent(id, data) {
  const log = await getLikesLog();
  const idx = log.findIndex((e) => e.id === id);
  if (idx >= 0) {
    log[idx] = { ...log[idx], ...data };
  } else {
    log.push({ id, ...data });
    if (log.length > MAX_LIKES_LOG) {
      log.splice(0, log.length - MAX_LIKES_LOG);
    }
  }
  await chrome.storage.local.set({ [LIKES_LOG_KEY]: log });
}

export async function updateLikeEventStatus(id, status, reasoning = "") {
  await upsertLikeEvent(id, {
    agentStatus: status,
    ...(reasoning ? { agentReasoning: reasoning } : {}),
  });
}
