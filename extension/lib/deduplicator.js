/**
 * deduplicator.js — Filters notification arrays to unseen item_liked events.
 */

import { getSeenEvents, isEventSeen, markEventSeen, pruneSeenEvents } from "./storage.js";

/**
 * Given the raw Vinted notifications array, return only the item_liked events
 * that haven't been seen before. Also prunes stale entries.
 */
export async function filterNewFavouriteEvents(notifications) {
  await pruneSeenEvents();

  const newEvents = [];
  for (const notif of notifications) {
    if (notif.entry_type !== 20) continue;  // 20 = item favourited
    const id = String(notif.id);
    if (await isEventSeen(id)) continue;
    newEvents.push(notif);
  }

  return newEvents;
}

/**
 * Mark a notification as having an alarm scheduled.
 */
export async function markAlarmSet(notificationId, alarmName) {
  await markEventSeen(notificationId, "alarm_set", { alarmName });
}

/**
 * Mark a notification as successfully sent.
 */
export async function markSent(notificationId, eventId) {
  await markEventSeen(notificationId, "sent", { eventId });
}

/**
 * Mark a notification as skipped (e.g. rate limited).
 */
export async function markSkipped(notificationId, reason) {
  await markEventSeen(notificationId, "skipped", { reason });
}

/**
 * Mark a notification as failed.
 */
export async function markFailed(notificationId, reason) {
  await markEventSeen(notificationId, "failed", { reason });
}
