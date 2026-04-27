/**
 * storage.js — Typed wrappers around chrome.storage.
 *
 * Settings (synced across devices): chrome.storage.sync
 * Runtime state (local only):       chrome.storage.local
 */

// ── Settings (chrome.storage.sync) ───────────────────────────────────────────

const DEFAULTS = {
  enabled: false,
  api_key: "",
  floor_pct: 80,
  daily_limit: 20,
};

export async function getSettings() {
  const result = await chrome.storage.sync.get(DEFAULTS);
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

/** Remove entries older than MAX_AGE_MS to prevent unbounded growth. */
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
  return new Date().toISOString().slice(0, 10); // "2026-04-26"
}

export async function getDailyCount() {
  const result = await chrome.storage.local.get(DAILY_COUNT_KEY);
  const stored = result[DAILY_COUNT_KEY];
  if (!stored || stored.date !== todayStr()) {
    return 0;
  }
  return stored.count;
}

export async function incrementDailyCount() {
  const count = await getDailyCount();
  await chrome.storage.local.set({
    [DAILY_COUNT_KEY]: { date: todayStr(), count: count + 1 },
  });
}

// ── Last send time (for inter-message gap enforcement) ───────────────────────

const LAST_SEND_KEY = "last_send_ts";

export async function getLastSendTs() {
  const result = await chrome.storage.local.get(LAST_SEND_KEY);
  return result[LAST_SEND_KEY] || 0;
}

export async function setLastSendTs(ts = Date.now()) {
  await chrome.storage.local.set({ [LAST_SEND_KEY]: ts });
}
