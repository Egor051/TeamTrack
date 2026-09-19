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

const CHECKLIST_COMMENT_PREFIX = "Комментарий:";

/** Returns the comment body without any user-entered display prefix. */
export function normalizeChecklistComment(value: string | null | undefined): string {
  let text = typeof value === "string" ? value.trim() : "";
  while (text.startsWith(CHECKLIST_COMMENT_PREFIX)) {
    text = text.slice(CHECKLIST_COMMENT_PREFIX.length).trimStart();
  }
  return text;
}

/** Formats a checklist comment consistently everywhere it is shown. */
export function formatChecklistComment(value: string | null | undefined): string {
  const text = normalizeChecklistComment(value);
  return text ? `${CHECKLIST_COMMENT_PREFIX} ${text}` : "";
}
