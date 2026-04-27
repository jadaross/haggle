/**
 * rate-limiter.js — Client-side safety layer.
 *
 * Two guards:
 * 1. Daily message cap (configurable, default 20)
 * 2. Minimum inter-message gap (3 minutes) even if events fire simultaneously
 */

import { getDailyCount, getLastSendTs } from "./storage.js";

const MIN_GAP_MS = 3 * 60 * 1000; // 3 minutes between sends

/**
 * Returns { allowed: true } or { allowed: false, reason }.
 */
export async function checkRateLimit(dailyLimit) {
  const sentToday = await getDailyCount();
  if (sentToday >= dailyLimit) {
    return { allowed: false, reason: "daily_limit_reached", sentToday };
  }

  const lastSend = await getLastSendTs();
  const msSinceLast = Date.now() - lastSend;
  if (msSinceLast < MIN_GAP_MS) {
    const waitMs = MIN_GAP_MS - msSinceLast;
    return { allowed: false, reason: "too_soon", waitMs };
  }

  return { allowed: true, sentToday };
}

/**
 * Compute a randomised delay in milliseconds before sending a message.
 * Range: 5–30 minutes. Prevents instant-response bot signals.
 */
export function randomSendDelayMs() {
  const minMs = 5 * 60 * 1000;
  const maxMs = 30 * 60 * 1000;
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Compute the alarm delay in minutes for a per-event alarm,
 * offset by the inter-message gap multiplied by queue position.
 *
 * queuePosition = 0-indexed position of this event in the current batch.
 */
export function alarmDelayMinutes(queuePosition = 0) {
  const baseMs = randomSendDelayMs();
  const gapOffsetMs = queuePosition * MIN_GAP_MS;
  return Math.ceil((baseMs + gapOffsetMs) / 60000); // round up to nearest minute
}
