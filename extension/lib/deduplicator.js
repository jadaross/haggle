/**
 * deduplicator.js — Filters notification arrays to unseen item_liked events.
 */

import { getSeenEvents, isEventSeen, markEventSeen, pruneSeenEvents } from "./storage.js";

/**
 * Given the raw Vinted notifications array, return only the item_liked events
 * that haven't been seen before. Also prunes stale entries.
 *
 * Vinted's notifications API has used both `entry_type` (numeric) and `type`
 * (string) fields historically. We accept either, and also fall back to any
 * notification whose link points at /items/ — that catches likes plus
 * item-related conversation activity that we still want to surface.
 */
export async function filterNewFavouriteEvents(notifications) {
  await pruneSeenEvents();

  const newEvents = [];
  let droppedNotLike = 0;
  let droppedSeen = 0;
  const sampleShapes = [];
  for (const notif of notifications) {
    if (sampleShapes.length < 3) {
      sampleShapes.push({
        id: notif.id,
        entry_type: notif.entry_type,
        type: notif.type,
        link: notif.link,
        title: notif.title || notif.body || "",
      });
    }
    if (!isItemLikeNotif(notif)) { droppedNotLike++; continue; }
    const id = String(notif.id);
    if (await isEventSeen(id)) { droppedSeen++; continue; }
    newEvents.push(notif);
  }

  console.log(
    `[Haggle dedup] in=${notifications.length} new=${newEvents.length} ` +
    `droppedNotLike=${droppedNotLike} droppedSeen=${droppedSeen}`,
    sampleShapes,
  );

  return newEvents;
}

function isItemLikeNotif(notif) {
  if (notif.entry_type === 20) return true;
  if (notif.type === "item_liked") return true;
  // Fallback: any notification linking to an item page
  const link = notif.link || "";
  return link.includes("/items/");
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
