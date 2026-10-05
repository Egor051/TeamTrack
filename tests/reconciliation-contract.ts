import { expect, it } from 'vitest';
import type { LocalCacheDriver, ReconciledItem } from '@/lib/local-cache/types';

export function reconciliationContract(driver: () => Promise<LocalCacheDriver>) {
  const item = (sync_version: number, is_archived = false): ReconciledItem => ({ id: 'item-1', task_id: 'task-1', percentage: 70, is_completed: false, comment: null, sync_version, is_archived });
  async function prepare(storage: LocalCacheDriver) {
    for (const mode of ['active', 'archived', 'all']) await storage.put({ user_id: 'user-a', key: `items:task-1:${mode}`,
      data: JSON.stringify(mode === 'archived' ? [] : [item(10)]), last_synced_at: '', schema_version: 1 });
    await storage.enqueue({ operation_id: 'ack', user_id: 'user-a', project_id: 'project-1', task_id: 'task-1', task_item_id: 'item-1',
      type: 'set_task_item_percentage', payload: { percentage: 70 }, created_at: '', status: 'pending' });
    await storage.acknowledgeOperation('user-a', 'ack', 11);
  }
  it.each(['archive', 'delete'])('AUD-08: atomically reconciles an ACK after %s', async (kind) => {
    const storage = await driver(); await prepare(storage);
    const current = kind === 'archive' ? item(12, true) : null;
    await storage.reconcileOperation('user-a', 'ack', current, current ? [current] : []);
    expect(await storage.listPending('user-a')).toEqual([]);
    expect(JSON.parse((await storage.get('user-a', 'items:task-1:active'))!.data)).toEqual([]);
    expect(JSON.parse((await storage.get('user-a', 'items:task-1:archived'))!.data)).toEqual(current ? [current] : []);
    expect(JSON.parse((await storage.get('user-a', 'items:task-1:all'))!.data)).toEqual(current ? [current] : []);
  });
  it('AUD-08: a late reconciliation cannot resurrect an item removed by pull', async () => {
    const storage = await driver(); await prepare(storage); await storage.initializePullCursor('user-a', 0);
    const before = await storage.listEntries('user-a');
    await storage.applyPullPage('user-a', 0, 2, [{ cursor: 2, task_id: 'task-1', task_item_id: 'item-1', change_type: 'delete', item: null }]);
    await expect(storage.reconcileOperation('user-a', 'ack', item(11), [item(11)], before.map(({ key, data }) => ({ key, data })))).rejects.toThrow();
    expect((await storage.listPending('user-a'))[0].status).toBe('synced_unreconciled');
    expect((await storage.get('user-a', 'sync:task-items:cursor'))!.data).toBe('2');
    expect(JSON.parse((await storage.get('user-a', 'items:task-1:active'))!.data)).toEqual([]);
    await storage.reconcileOperation('user-a', 'ack', null, []);
    expect(await storage.listPending('user-a')).toEqual([]);
  });
  it('AUD-08: reconciliation preserves a newer confirmed version', async () => {
    const storage = await driver(); await prepare(storage);
    await storage.put({ user_id: 'user-a', key: 'items:task-1:all', data: JSON.stringify([item(13, true)]), last_synced_at: '', schema_version: 1 });
    await storage.reconcileOperation('user-a', 'ack', item(11), [item(11)]);
    expect(JSON.parse((await storage.get('user-a', 'items:task-1:active'))!.data)).toEqual([]);
    expect(JSON.parse((await storage.get('user-a', 'items:task-1:all'))!.data)).toEqual([item(13, true)]);
  });
  it('AUD-08: reconciliation cannot remove an unrelated item missing from a paginated HTTP snapshot', async () => {
    const storage = await driver(); await prepare(storage);
    const unrelated = { ...item(10), id: 'other-item' };
    await storage.put({ user_id: 'user-a', key: 'items:task-1:active', data: JSON.stringify([item(10), unrelated]), last_synced_at: '', schema_version: 1 });
    await storage.reconcileOperation('user-a', 'ack', item(11), [item(11)]);
    expect(JSON.parse((await storage.get('user-a', 'items:task-1:active'))!.data)).toEqual([item(11), unrelated]);
  });
}
