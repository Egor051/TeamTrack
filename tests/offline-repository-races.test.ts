import { beforeEach, expect, it, vi } from 'vitest';
import type { TaskItem } from '@/lib/supabase/client';

const state = vi.hoisted(() => ({ reply: null as null | (() => void) }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { from: (table: string) => {
  const query = { select: () => query, eq: () => query, order: () => query, range: () => query,
    maybeSingle: async () => ({ data: { id: 'task' }, error: null }),
    then: (resolve: (value: unknown) => void) => new Promise<void>((done) => {
      state.reply = () => { resolve({ data: [item(10)], error: null }); done(); };
    }),
  };
  if (table !== 'tasks' && table !== 'task_items') throw new Error(table);
  return query;
} } }));
vi.mock('@/lib/local-cache/cache', async () => {
  const { localCacheDriver } = await import('@/lib/local-cache/driver');
  return { activeCacheUserId: async () => 'user', getCached: async (_user: string, key: string) => {
    const entry = await localCacheDriver.get('user', key); return entry ? JSON.parse(entry.data) : null;
  } };
});
vi.mock('@/lib/local-cache/outbox', () => ({ applyPendingOperations: (rows: unknown) => rows, listPendingOperations: async () => [] }));
vi.mock('@/lib/local-cache/sync', () => ({ announceSyncChange: vi.fn(), subscribeSyncChanges: vi.fn() }));
vi.mock('@/lib/local-cache/status', () => ({ getSyncState: vi.fn(), subscribeSyncState: vi.fn() }));
vi.mock('@/lib/local-cache/edit', () => ({ performSupportedEdit: vi.fn() }));
import { localCacheDriver } from '@/lib/local-cache/driver';
import { ChecklistLocalRepository } from '@/lib/local-cache/repository';

function item(version: number): TaskItem { return { id: 'item', task_id: 'task', sync_version: version, percentage: version } as TaskItem; }
async function save(rows: TaskItem[]) {
  await localCacheDriver.put({ user_id: 'user', key: 'items:task:active', data: JSON.stringify(rows), last_synced_at: '', schema_version: 1 });
}
beforeEach(async () => { state.reply = null; await save([item(10)]); });
it.each(['update', 'insert', 'delete'])('AUD-01: a late refresh cannot undo a newer pull (%s)', async (change) => {
  const refresh = ChecklistLocalRepository.refreshTaskItems('user', 'task', 'active');
  await vi.waitFor(() => expect(state.reply).toBeTypeOf('function'));
  const newer = change === 'delete' ? [] : change === 'insert' ? [item(11), { ...item(11), id: 'new' }] : [item(11)];
  await save(newer);
  await localCacheDriver.put({ user_id: 'user', key: 'sync:task-items:cursor', data: '11', last_synced_at: '', schema_version: 1 });
  state.reply!();
  expect(await refresh).toEqual(newer);
  expect(JSON.parse((await localCacheDriver.get('user', 'items:task:active'))!.data)).toEqual(newer);
  expect((await localCacheDriver.get('user', 'sync:task-items:cursor'))!.data).toBe('11');
});
