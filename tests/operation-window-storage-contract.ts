import { describe, expect, it } from 'vitest';
import type { LocalCacheDriver, OfflineOperation, SyncConflict } from '@/lib/local-cache/types';
import type { OperationHandle } from '@/lib/supabase/operation-handle';
import { nextPushOperation } from '@/lib/local-cache/failed-chain';

const user = 'window-storage';
const handle = (id: string, epoch = 1): OperationHandle => ({ id, protocol_version: 3, fingerprint_version: 1,
  generation: '11111111-1111-4111-8111-111111111111', epoch, admit_until: '2030-01-02', replay_until: '2030-04-02' });
export function operationWindowStorageContract(load: () => Promise<LocalCacheDriver>) {
  async function seed(driver: LocalCacheDriver) {
    await driver.put({ user_id: user, key: 'items:window-task:active', schema_version: 1, last_synced_at: '2030-01-01',
      data: JSON.stringify(['window-item','independent-item'].map(id => ({ id, sync_version: 10, percentage: 20, is_completed: false, comment: null }))) });
  }
  async function enqueue(driver: LocalCacheDriver, id: string, item = 'window-item', protocol = 3) {
    return driver.enqueue({ user_id: user, operation_id: id, task_id: 'window-task', task_item_id: item, project_id: 'window-project',
      created_at: '2000-01-01', status: 'pending', protocol_version: protocol, type: 'set_task_item_percentage', payload: { percentage: 60 } });
  }
  async function conflict(driver: LocalCacheDriver, operations: OfflineOperation[]) {
    const c: SyncConflict = { conflict_id: 'window-conflict', user_id: user, task_id: 'window-task', task_item_id: 'window-item',
      project_id: 'window-project', operation_ids: operations.map(row => row.operation_id), server_version: 11,
      local_effective_state: { id: 'window-item', percentage: 60, is_completed: false, comment: null },
      server_state: { id: 'window-item', percentage: 30, is_completed: false, comment: null }, conflicting_fields: ['progress'],
      project_name: 'Project', task_name: 'Task', item_name: 'Item', created_at: '', updated_at: '', status: 'unresolved' };
    await driver.createConflict(c); return c;
  }
  describe('v3 durable operation window contract', () => {
    it('binds a decades-old never-sent draft only at its first send and preserves payload/version', async () => {
      const d = await load(); await seed(d); const draft = await enqueue(d, 'old-draft');
      expect(draft.operation_handle).toBeUndefined();
      await d.bindOperationHandle(user, draft.operation_id, handle(draft.operation_id, 27));
      const [bound] = await d.listPending(user);
      expect(bound).toMatchObject({ operation_handle: handle(draft.operation_id, 27), expected_version: 10, payload: { percentage: 60 }, created_at: '2000-01-01' });
    });
    it('concurrent bindings return the first durable full handle instead of moving a sent operation', async () => {
      const d = await load(); await seed(d); await enqueue(d, 'concurrent-bind');
      const rows = await Promise.all([d.bindOperationHandle(user, 'concurrent-bind', handle('concurrent-bind', 1)), d.bindOperationHandle(user, 'concurrent-bind', handle('concurrent-bind', 2))]);
      expect(rows[0].operation_handle).toEqual(rows[1].operation_handle);
      expect((await d.listPending(user))[0].operation_handle).toEqual(rows[0].operation_handle);
    });
    it('explicit v3 rebase replaces an attempted ID and all dependency/conflict references in one transaction', async () => {
      const d = await load(); await seed(d);
      const first = await enqueue(d, 'sent-attempt'); await d.bindOperationHandle(user, first.operation_id, handle(first.operation_id));
      const next = await enqueue(d, 'dependent-draft'); await conflict(d, [first, next]);
      await d.rebaseConflict(user, 'window-conflict', 12);
      const rows = await d.listPending(user); expect(rows[0].operation_id).not.toBe(first.operation_id);
      expect(rows[0].operation_id[14]).toBe('8');
      expect(rows[1].operation_id).toBe(next.operation_id); // Never-sent dependency keeps its identity.
      expect(rows[0]).toMatchObject({ logical_operation_id: first.operation_id, operation_handle: null, status: 'pending', expected_version: 12, depends_on_operation_id: null });
      expect(rows[1].depends_on_operation_id).toBe(rows[0].operation_id);
      expect((await d.listConflicts(user))[0].operation_ids).toEqual(rows.map(row => row.operation_id));
    });
    it('N02 rebase cannot replace a pending bound attempt or its dependency after a lost ACK', async () => {
      const d = await load(); await seed(d);
      const first = await enqueue(d, 'confirmed-conflict'); await d.bindOperationHandle(user, first.operation_id, handle(first.operation_id));
      const next = await enqueue(d, 'following-draft'); await conflict(d, [first, next]);
      await d.rebaseConflict(user, 'window-conflict', 11);
      const pending = (await d.listPending(user))[0]; await d.bindOperationHandle(user, pending.operation_id, handle(pending.operation_id, 7));
      const before = await d.listPending(user), metadata = await d.listConflicts(user);
      await d.rebaseConflict(user, 'window-conflict', 99);
      expect(await d.listPending(user)).toEqual(before); expect(await d.listConflicts(user)).toEqual(metadata);
    });
    it('N01 terminal review releases only its gate and preserves both the full handle and dependent IDs', async () => {
      const d = await load(); await seed(d);
      const first = await enqueue(d, 'terminal-conflict'); await d.bindOperationHandle(user, first.operation_id, handle(first.operation_id));
      const next = await enqueue(d, 'terminal-dependent'); await conflict(d, [first, next]);
      await d.markOperation(user, first.operation_id, 'review', undefined, 'TT_OPERATION_HISTORY_RESET', 'window-conflict');
      const before = await d.listPending(user);
      expect(before[0]).toMatchObject({ operation_id: first.operation_id, operation_handle: handle(first.operation_id), status: 'review', last_error: 'TT_OPERATION_HISTORY_RESET' });
      expect(before[1]).toMatchObject({ operation_id: next.operation_id, depends_on_operation_id: first.operation_id, status: 'pending' });
      expect(await d.listConflicts(user)).toEqual([]);
      await expect(d.bindOperationHandle(user, first.operation_id, handle(first.operation_id, 2))).rejects.toThrow();
      expect(await d.listPending(user)).toEqual(before);
    });
    it('N01 cancelled terminal transition preserves outbox and conflict together', async () => {
      const d = await load(); await seed(d); const first = await enqueue(d, 'cancel-review');
      await d.bindOperationHandle(user, first.operation_id, handle(first.operation_id)); await conflict(d, [first]);
      const before = await d.listPending(user), metadata = await d.listConflicts(user), abort = new AbortController();
      abort.abort();
      await expect(d.withOperation!(abort.signal).markOperation(user, first.operation_id, 'review', undefined, 'TT_OPERATION_EXPIRED', 'window-conflict')).rejects.toThrow();
      expect(await d.listPending(user)).toEqual(before); expect(await d.listConflicts(user)).toEqual(metadata);
    });
    it('N01 review state is never rebased even when an older conflict record survives a restart', async () => {
      const d = await load(); await seed(d); const first = await enqueue(d, 'retained-review');
      await d.bindOperationHandle(user, first.operation_id, handle(first.operation_id)); await conflict(d, [first]);
      await d.markOperation(user, first.operation_id, 'review', undefined, 'TT_OPERATION_RESULT_REDACTED');
      const before = await d.listPending(user), metadata = await d.listConflicts(user);
      await d.rebaseConflict(user, 'window-conflict', 12);
      expect(await d.listPending(user)).toEqual(before); expect(await d.listConflicts(user)).toEqual(metadata);
    });
    it('N02 a concurrent keep-server action cannot discard an unknown or ACKed attempt', async () => {
      const d = await load(); await seed(d); const first = await enqueue(d, 'do-not-discard-unknown');
      await d.bindOperationHandle(user, first.operation_id, handle(first.operation_id)); await conflict(d, [first]);
      await d.rebaseConflict(user, 'window-conflict', 11);
      const rebased = (await d.listPending(user))[0]; await d.bindOperationHandle(user, rebased.operation_id, handle(rebased.operation_id));
      const unknown = await d.listPending(user), metadata = await d.listConflicts(user);
      await expect(d.resolveServerConflict(user, 'window-conflict')).rejects.toThrow();
      expect(await d.listPending(user)).toEqual(unknown); expect(await d.listConflicts(user)).toEqual(metadata);
      await d.acknowledgeOperation(user, rebased.operation_id, 12);
      const acked = await d.listPending(user);
      await expect(d.resolveServerConflict(user, 'window-conflict')).rejects.toThrow();
      expect(await d.listPending(user)).toEqual(acked); expect(await d.listConflicts(user)).toEqual(metadata);
    });
    it('legacy v2 rebase preserves its old UUID and fingerprint semantics', async () => {
      const d = await load(); await seed(d); const first = await enqueue(d, 'legacy-attempt', 'window-item', 2);
      await conflict(d, [first]); await d.rebaseConflict(user, 'window-conflict', 11);
      expect((await d.listPending(user))[0]).toMatchObject({ operation_id: 'legacy-attempt', expected_version: 11, protocol_version: 2 });
    });
    it('expiry retains the draft and blocks its dependent item while independent work continues', async () => {
      const d = await load(); await seed(d); const first = await enqueue(d, 'unknown');
      await d.bindOperationHandle(user, first.operation_id, handle(first.operation_id)); await enqueue(d, 'dependent');
      await enqueue(d, 'independent', 'independent-item'); await d.markOperation(user, 'unknown', 'review', undefined, 'TT_OPERATION_EXPIRED');
      const rows = await d.listPending(user); expect(rows).toHaveLength(3);
      expect(nextPushOperation(rows)?.operation_id).toBe('independent');
      expect(rows[0]).toMatchObject({ status: 'review', operation_handle: handle(first.operation_id), payload: { percentage: 60 } });
      expect(await d.listConflicts(user)).toEqual([]);
    });
    it('a cancelled handle write cannot erase a pending draft or create a partial binding', async () => {
      const d = await load(); await seed(d); await enqueue(d, 'cancel-bind');
      if (!d.withOperation) throw new Error('Real operation-scoped driver required');
      const controller = new AbortController(); controller.abort();
      await expect(d.withOperation(controller.signal).bindOperationHandle(user, 'cancel-bind', handle('cancel-bind'))).rejects.toBeDefined();
      expect((await d.listPending(user))[0].operation_handle ?? null).toBeNull();
    });
    it('a foreign account cannot bind or rebase another account operation', async () => {
      const d = await load(); await seed(d); const first = await enqueue(d, 'private-attempt'); await conflict(d, [first]);
      await expect(d.bindOperationHandle('foreign-user', 'private-attempt', handle('private-attempt'))).rejects.toBeDefined();
      await expect(d.rebaseConflict('foreign-user', 'window-conflict', 99)).rejects.toBeDefined();
      expect((await d.listPending(user))[0]).toMatchObject({ operation_id: 'private-attempt', expected_version: 10 });
    });
  });
}
