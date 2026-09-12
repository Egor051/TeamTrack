export function filterChecklistItems<T extends { is_archived: boolean }>(items: T[], archivedOnly: boolean): T[] {
  return items.filter((item) => item.is_archived === archivedOnly);
}
