import { describe, expect, it } from 'vitest';
import { applyPullToEntries, hasMeaningfulPull } from '@/lib/local-cache/pull-cache';
import type { CacheEntry, PullChange } from '@/lib/local-cache/types';

const item = { id: 'item', task_id: 'task', sync_version: 5, percentage: 60, is_completed: false, comment: 'Confirmed', is_archived: false };
const entries: CacheEntry[] = [{ user_id: 'user-a', key: 'items:task:active', data: JSON.stringify([item]), last_synced_at: '', schema_version: 1 }];
const change = (version: number): PullChange => ({ cursor: 1, task_id: 'task', task_item_id: 'item', change_type: 'upsert', item: { ...item, sync_version: version } });
describe('meaningful pull and confirmed versions', () => {
  it.each([4, 5])('advances historical version %i without rolling back or advertising synchronization', (version) => {
    expect(hasMeaningfulPull(entries, [change(version)])).toBe(false);
    expect(applyPullToEntries(entries, [change(version)])).toEqual(entries);
  });
  it('advertises and applies a new confirmed version', () => {
    expect(hasMeaningfulPull(entries, [change(6)])).toBe(true);
    expect(JSON.parse(applyPullToEntries(entries, [change(6)])[0].data)[0].sync_version).toBe(6);
  });
  it('repairs stale cache variants using the newest confirmation without rolling either one back', () => {
    const mixed = [...entries, { ...entries[0], key: 'items:task:all', data: JSON.stringify([{ ...item, sync_version: 7, percentage: 80 }]) }];
    expect(hasMeaningfulPull(mixed, [change(6)])).toBe(true);
    const repaired = applyPullToEntries(mixed, [change(6)]);
    for (const entry of repaired) expect(JSON.parse(entry.data)[0]).toMatchObject({ sync_version: 7, percentage: 80 });
    expect(hasMeaningfulPull(repaired, [change(6)])).toBe(false);
  });
  it('ignores JSON field ordering differences in an already confirmed version', () => {
    const { comment, ...rest } = item;
    const same = { ...change(5), item: { comment, ...rest } };
    expect(hasMeaningfulPull(entries, [same])).toBe(false);
    expect(applyPullToEntries(entries, [same])).toEqual(entries);
  });
  it('ignores unrelated events and detects removal of an existing cached item', () => {
    expect(hasMeaningfulPull(entries, [{ ...change(6), task_id: 'another-task' }])).toBe(false);
    const deletion: PullChange = { ...change(6), change_type: 'delete', item: null };
    expect(hasMeaningfulPull(entries, [deletion])).toBe(true);
    expect(JSON.parse(applyPullToEntries(entries, [deletion])[0].data)).toEqual([]);
  });
});
