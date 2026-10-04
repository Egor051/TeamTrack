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
    // A bootstrap/online read can already contain a later confirmation than
    // this historical feed page. Advancing the cursor must not undo that read.
    const confirmed = [...byKey.values()].filter((entry) => entry.key.startsWith(`items:${change.task_id}:`))
      .flatMap((entry) => JSON.parse(entry.data) as ReconciledItem[]).filter((row) => row.id === change.task_item_id);
    let newest = change.item;
    if (newest && validSyncVersion(newest.sync_version)) for (const row of confirmed) {
      if (validSyncVersion(row.sync_version) && row.sync_version > newest.sync_version!) newest = row;
    }
    const effective = newest === change.item ? change : { ...change, item: newest };
    let changed = false;
    for (const mode of ['active', 'archived', 'all']) {
      const key = `items:${change.task_id}:${mode}`;
      const entry = byKey.get(key);
      if (!entry) continue;
      const rows = JSON.parse(entry.data) as ReconciledItem[];
      const current = rows.find((row) => row.id === change.task_item_id);
      if (change.change_type !== 'delete' && newest && current && validSyncVersion(current.sync_version)
        && current.sync_version === newest.sync_version && (mode === 'all' || newest.is_archived === (mode === 'archived'))) continue;
      const data = JSON.stringify(replaceRow(rows, effective, mode));
      if (data === entry.data) continue;
      changed = true;
      byKey.set(key, { ...entry, data, last_synced_at: new Date().toISOString() });
    }
    if (changed) { touchedTasks.add(change.task_id); byKey.delete(`last-editors:${change.task_id}`); }
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

export function hasMeaningfulPull(entries: CacheEntry[], changes: PullChange[]): boolean {
  const next = applyPullToEntries(entries, changes);
  return next.length !== entries.length || next.some((entry) => entries.find((previous) => previous.key === entry.key)?.data !== entry.data);
}
