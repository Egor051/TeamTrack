export function filterChecklistItems<T extends { is_archived: boolean }>(items: T[], archivedOnly: boolean): T[] {
  return items.filter((item) => item.is_archived === archivedOnly);
}

/** Parse the raw progress field without coercing malformed input. Zero is not
 * a saveable progress change; use the checkbox or an existing value instead. */
export function parsePercentageInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : null;
}
