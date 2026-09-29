import { LOCAL_CACHE_SCHEMA_VERSION, type CacheEntry, type OfflineOperation, type ReconciledItem } from './types';

export const reconciledKeys = (operation: OfflineOperation) => [
  `items:${operation.task_id}:active`,
  `items:${operation.task_id}:archived`,
  `items:${operation.task_id}:all`,
  `task-stats:${operation.project_id}:active`,
  `last-editors:${operation.task_id}`,
];

export function reconcileEntries(
  entries: (CacheEntry | null)[], operation: OfflineOperation, item: ReconciledItem, activeSnapshot: ReconciledItem[],
): (CacheEntry | null)[] {
  const next = [...entries];
  if (!activeSnapshot.some((row) => row.id === item.id)) throw new Error('Confirmed item missing from task snapshot');
  const activeRows = entries[0] ? JSON.parse(entries[0].data) as ReconciledItem[] : null;
  if (!activeRows?.some((row) => row.id === item.id)) {
    next[0] = { user_id: operation.user_id, key: `items:${operation.task_id}:active`,
      data: JSON.stringify(activeSnapshot), last_synced_at: new Date().toISOString(),
      schema_version: LOCAL_CACHE_SCHEMA_VERSION };
  }
  for (let index = 0; index < 3; index += 1) {
    if (index === 0 && next[0] !== entries[0]) continue;
    const entry = entries[index];
    if (!entry) continue;
    const rows = JSON.parse(entry.data) as ReconciledItem[];
    const patched = rows.map((row) => row.id === item.id ? { ...row, ...item } : row);
    next[index] = { ...entry, data: JSON.stringify(patched), last_synced_at: new Date().toISOString() };
  }
  // The stats snapshot may cover multiple tasks. Update this task from the
  // reconciled active item list, or invalidate stats if that list is absent.
  const active = next[0];
  const stats = entries[3];
  if (stats && active) {
    const items = (JSON.parse(active.data) as (ReconciledItem & { is_archived?: boolean })[])
      .filter((row) => row.is_archived !== true);
    const rows = JSON.parse(stats.data) as { id: string; itemCount: number; completedCount: number; progressPercent: number }[];
    next[3] = { ...stats, data: JSON.stringify(rows.map((row) => row.id === operation.task_id
      ? { ...row, itemCount: items.length, completedCount: items.filter((value) => value.is_completed).length,
        progressPercent: items.length ? items.reduce((sum, value) => sum + value.percentage, 0) / items.length : 0 }
      : row)) };
  } else {
    next[3] = null;
  }
  // The last-editor summary must be fetched again after a confirmed mutation.
  next[4] = null;
  return next;
}
