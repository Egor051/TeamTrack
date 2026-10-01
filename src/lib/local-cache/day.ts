/** UTC instant of 00:00 UTC+3, independent of the device timezone. */
export function getUtcPlus3DayStart(now = new Date()): string {
  const local = new Date(now.getTime() + 3 * 3600000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 3 * 3600000).toISOString();
}
