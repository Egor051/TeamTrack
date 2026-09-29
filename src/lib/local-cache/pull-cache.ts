import type { CacheEntry, PullChange, ReconciledItem } from './types';

function replaceRow(rows: ReconciledItem[], change: PullChange, mode: string): ReconciledItem[] {
  const next = rows.filter((row) => row.id !== change.task_item_id);
  const item = change.item;
  if (change.change_type === 'delete' || !item) return next;
  if (mode === 'active' && item.is_archived) return next;
  if (mode === 'archived' && !item.is_archived) return next;
  next.push(item);
  next.sort((a, b) => Number((a as { position?: number }).position ?? 0) - Number((b as { position?: number }).position ?? 0)
    || a.id.localeCompare(b.id));
  return next;
}

// Pure cache transform shared by IndexedDB, SQLite, and their transaction tests.
export function applyPullToEntries(entries: CacheEntry[], changes: PullChange[], projectId?: string): CacheEntry[] {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const touchedTasks = new Set<string>();
  for (const change of changes) {
    touchedTasks.add(change.task_id);
    for (const mode of ['active', 'archived', 'all']) {
      const key = `items:${change.task_id}:${mode}`;
      const entry = byKey.get(key);
      if (!entry) continue;
      const rows = JSON.parse(entry.data) as ReconciledItem[];
      byKey.set(key, { ...entry, data: JSON.stringify(replaceRow(rows, change, mode)), last_synced_at: new Date().toISOString() });
    }
    byKey.delete(`last-editors:${change.task_id}`);
  }
  if (projectId) {
    const statsKey = `task-stats:${projectId}:active`;
    const stats = byKey.get(statsKey);
    if (stats) {
      const rows = JSON.parse(stats.data) as { id: string; itemCount: number; completedCount: number; progressPercent: number }[];
      const updated = rows.map((row) => {
        if (!touchedTasks.has(row.id)) return row;
        const active = byKey.get(`items:${row.id}:active`);
        if (!active) return row;
        const items = JSON.parse(active.data) as ReconciledItem[];
        return { ...row, itemCount: items.length, completedCount: items.filter((item) => item.is_completed).length,
          progressPercent: items.length ? items.reduce((sum, item) => sum + item.percentage, 0) / items.length : 0 };
      });
      byKey.set(statsKey, { ...stats, data: JSON.stringify(updated) });
    }
  }
  return [...byKey.values()];
}

export function validSyncVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
