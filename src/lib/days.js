import { config } from '../config.js';

/** YYYY-MM-DD in the configured timezone (default Myanmar time). */
export function dayKey(date = new Date()) {
  const shifted = new Date(date.getTime() + config.tzOffsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** Start (UTC Date) of the current day in the configured timezone. */
export function dayStart(date = new Date()) {
  return new Date(Date.parse(dayKey(date) + 'T00:00:00.000Z') - config.tzOffsetMinutes * 60_000);
}

export function yesterdayKey() {
  return dayKey(new Date(Date.now() - 24 * 3600 * 1000));
}
