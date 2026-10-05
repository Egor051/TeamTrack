import { LOCAL_CACHE_SCHEMA_VERSION, type CacheEntry, type OfflineOperation, type ReconciledItem } from './types';
import { validSyncVersion } from './pull-cache';

export const reconciledKeys = (operation: OfflineOperation) => [
  `items:${operation.task_id}:active`,
  `items:${operation.task_id}:archived`,
  `items:${operation.task_id}:all`,
  `task-stats:${operation.project_id}:active`,
  `last-editors:${operation.task_id}`,
];

export function reconcileEntries(
  entries: (CacheEntry | null)[], operation: OfflineOperation, item: ReconciledItem | null, snapshot: ReconciledItem[] | null,
): (CacheEntry | null)[] {
  // A revoked/missing task must not retain readable data. The operation was
  // already durably ACKed, so it can be retired without replaying a mutation.
  if (snapshot === null) return entries.map(() => null);
  const next = [...entries];
  if (item && !snapshot.some((row) => row.id === item.id)) throw new Error('Confirmed item missing from task snapshot');
  const confirmed = entries.slice(0, 3).flatMap((entry) => entry ? JSON.parse(entry.data) as ReconciledItem[] : []);
  const rows = snapshot.map((row) => confirmed.reduce((newest, cached) => cached.id === row.id
    && validSyncVersion(cached.sync_version) && validSyncVersion(newest.sync_version)
    && cached.sync_version > newest.sync_version ? cached : newest, row));
  for (let index = 0; index < 3; index += 1) {
    const entry = entries[index];
    if (!entry && index !== 0) continue;
    // Reconciliation owns only this ACK's item. Preserve unrelated membership;
    // HTTP pagination is not an atomic snapshot of concurrent structural edits.
    const currentRows = entry ? JSON.parse(entry.data) as ReconciledItem[] : rows;
    const newest = rows.find((row) => row.id === operation.task_item_id);
    const patched = currentRows.filter((row) => row.id !== operation.task_item_id);
    if (newest && (index === 2 || Boolean(newest.is_archived) === (index === 1))) patched.push(newest);
    patched.sort((a, b) => Number((a as { position?: number }).position ?? 0) - Number((b as { position?: number }).position ?? 0) || a.id.localeCompare(b.id));
    const filtered = patched.filter((row) => index === 2 || Boolean(row.is_archived) === (index === 1));
    next[index] = { ...(entry ?? { user_id: operation.user_id, key: `items:${operation.task_id}:active`, schema_version: LOCAL_CACHE_SCHEMA_VERSION }),
      data: JSON.stringify(filtered), last_synced_at: new Date().toISOString() };
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
