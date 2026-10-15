import { LOCAL_CACHE_SCHEMA_VERSION, type CacheEntry, type OfflineOperation, type ReconciledItem } from './types';
import { validSyncVersion } from './pull-cache';
import { patchChecklistOverview } from './checklist-overview';
import { progressStatus } from '@/features/projects/deadlines';
import type { ChecklistOverviewItem } from '@/features/projects/deadlines';

export const reconciledKeys = (operation: OfflineOperation) => [
  `items:${operation.task_id}:active`,
  `items:${operation.task_id}:archived`,
  `items:${operation.task_id}:all`,
  `task-stats:${operation.project_id}:active`,
  `last-editors:${operation.task_id}`,
  'checklist-overview',
];

export function reconcileEntries(
  entries: (CacheEntry | null)[], operation: OfflineOperation, item: ReconciledItem | null, snapshot: ReconciledItem[] | null,
): (CacheEntry | null)[] {
  // A revoked/missing task must not retain readable data. The operation was
  // already durably ACKed, so it can be retired without replaying a mutation.
  if (snapshot === null) return entries.map((entry, index) => index === 5 && entry ? { ...entry,
    data: JSON.stringify((JSON.parse(entry.data) as ChecklistOverviewItem[]).filter((row) => row.task_id !== operation.task_id)) } : null);
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
    const rows = JSON.parse(stats.data) as { id: string; status?: string; itemCount: number; completedCount: number; progressPercent: number }[];
    const progressPercent = items.length ? items.reduce((sum, value) => sum + value.percentage, 0) / items.length : 0;
    next[3] = { ...stats, data: JSON.stringify(rows.map((row) => row.id === operation.task_id
      ? { ...row, itemCount: items.length, completedCount: items.filter((value) => value.percentage === 100).length,
        progressPercent, status: progressStatus(progressPercent, row.status === 'archived') }
      : row)) };
  } else {
    next[3] = null;
  }
  // The last-editor summary must be fetched again after a confirmed mutation.
  next[4] = null;
  if (entries[5]) {
    const confirmedItem = rows.find((row) => row.id === operation.task_item_id) ?? null;
    next[5] = { ...entries[5], data: JSON.stringify(patchChecklistOverview(JSON.parse(entries[5].data), {
      cursor: 0, task_id: operation.task_id, task_item_id: operation.task_item_id,
      change_type: confirmedItem ? 'upsert' : 'delete', item: confirmedItem,
    }, operation.project_id)) };
  }
  return next;
}
