import { describe, expect, it } from 'vitest';
import type { LocalCacheDriver, OfflineOperationInput } from '@/lib/local-cache/types';

export function failedChainContract(getDriver: () => Promise<LocalCacheDriver>) {
  const input = (id: string, item = 'item'): OfflineOperationInput => ({ operation_id: id, user_id: 'user',
    project_id: 'project', task_id: 'task', task_item_id: item, type: 'set_task_item_comment',
    payload: { comment: id }, created_at: '2026-10-17', status: 'pending', expected_version: 10 });
  async function setup() {
    const driver = await getDriver();
    await driver.put({ user_id: 'user', key: 'items:task:active',
      data: JSON.stringify([{ id: 'item', task_id: 'task', sync_version: 10 }, { id: 'other', task_id: 'task', sync_version: 10 }]),
      last_synced_at: '', schema_version: 1 });
    await driver.enqueue(input('first')); await driver.enqueue(input('dependent'));
    await driver.enqueue(input('independent', 'other'));
    await driver.markOperation('user', 'first', 'failed');
    return driver;
  }
  describe('B02 transactional cancellation', () => {
    it('removes the failed dependency chain, retains independent work and survives repeat cancellation/reopening', async () => {
      const driver = await setup();
      const chain = (await driver.listPending('user')).filter((row) => row.task_item_id === 'item');
      await (await getDriver()).discardFailedChain('user', 'task', 'item', 'project', null, chain);
      await (await getDriver()).discardFailedChain('user', 'task', 'item', 'project', null, chain);
      expect((await driver.listPending('user')).map((row) => row.operation_id)).toEqual(['independent']);
      expect(JSON.parse((await driver.get('user', 'items:task:active'))!.data)).toMatchObject([{ id: 'other' }]);
    });
    it.each(['pending', 'synced_unreconciled', 'conflict'] as const)('rejects a cancel captured before a concurrent %s transition', async (status) => {
      const driver = await setup();
      const chain = (await driver.listPending('user')).filter((row) => row.task_item_id === 'item');
      await driver.markOperation('user', 'first', status);
      await expect(driver.discardFailedChain('user', 'task', 'item', 'project', null, chain)).rejects.toThrow();
      expect(await driver.listPending('user')).toHaveLength(3);
      expect(JSON.parse((await driver.get('user', 'items:task:active'))!.data)).toHaveLength(2);
    });
    it('never deletes an acknowledged predecessor even if a later write failed', async () => {
      const driver = await setup();
      await driver.acknowledgeOperation('user', 'first', 11);
      await driver.markOperation('user', 'dependent', 'failed');
      await expect(driver.discardFailedChain('user', 'task', 'item', 'project', null)).rejects.toThrow();
      expect(await driver.listPending('user')).toHaveLength(3);
      await driver.discardFailedChain('other-user', 'task', 'item', 'project', null);
      expect(await driver.listPending('user')).toHaveLength(3);
    });
  });
}
