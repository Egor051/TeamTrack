import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineOperation, OfflineOperationInput } from '@/lib/local-cache/types';

const storage = vi.hoisted(() => ({
  userId: 'user-a', operations: [] as OfflineOperation[], fail: false,
  enqueue: vi.fn(), listPending: vi.fn(),
}));

vi.mock('@/lib/local-cache/cache', () => ({
  activeCacheUserId: async () => storage.userId,
  isTransportFailure: (error: { message?: string; status?: number; code?: string }) =>
    error.status !== 401 && error.status !== 403 && (!error.code || error.code === 'PGRST000')
      && /failed to fetch|network request failed/i.test(error.message ?? ''),
}));
vi.mock('@/lib/local-cache/driver', () => ({ localCacheDriver: {
  enqueue: storage.enqueue, listPending: storage.listPending,
} }));

import { applyPendingOperations, enqueueOperation, listPendingOperations, offlineSyncEnabled, offlineWriteEnabled } from '@/lib/local-cache/outbox';
import { performSupportedEdit } from '@/lib/local-cache/edit';

const context = { userId: 'user-a', projectId: 'project-1', taskId: 'task-1', itemId: 'item-1' };
const base = [{ id: 'item-1', percentage: 20, is_completed: false, comment: null }];
const percentage = (value: number) => ({ type: 'set_task_item_percentage' as const, payload: { percentage: value } });
const state = (completed: boolean) => ({ type: 'set_task_item_state' as const, payload: { completed } });
const comment = (value: string) => ({ type: 'set_task_item_comment' as const, payload: { comment: value } });

beforeEach(() => {
  vi.stubEnv('EXPO_PUBLIC_OFFLINE_WRITE_ENABLED', 'true');
  vi.stubEnv('EXPO_PUBLIC_OFFLINE_SYNC_ENABLED', 'false');
  storage.userId = 'user-a';
  storage.operations = [];
  storage.fail = false;
  storage.enqueue.mockImplementation(async (operation: OfflineOperationInput) => {
    if (storage.fail) throw new Error('storage unavailable');
    const saved = { ...operation, sequence: storage.operations.length + 1 };
    storage.operations.push(saved);
    return saved;
  });
  storage.listPending.mockImplementation(async (userId: string, taskId?: string) =>
    storage.operations.filter((operation) => operation.user_id === userId && (!taskId || operation.task_id === taskId)));
});

describe('pending operations', () => {
  it('keeps every action in order and leaves the confirmed snapshot untouched', async () => {
    await enqueueOperation('user-a', 'project-1', 'task-1', 'item-1', percentage(40));
    await enqueueOperation('user-a', 'project-1', 'task-1', 'item-1', percentage(70));
    const operations = await listPendingOperations('user-a', 'task-1');
    expect(operations.map((op) => op.sequence)).toEqual([1, 2]);
    expect(operations.every((op) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab]/i.test(op.operation_id))).toBe(true);
    expect(applyPendingOperations(base, operations, 'user-a', 'task-1')[0].percentage).toBe(70);
    expect(base[0].percentage).toBe(20);
  });

  it('uses the backend checkbox and percentage coupling in action order', async () => {
    const first = await enqueueOperation('user-a', 'project-1', 'task-1', 'item-1', state(true));
    expect(applyPendingOperations(base, [first], 'user-a', 'task-1')[0]).toMatchObject({ percentage: 100, is_completed: true });
    const second = await enqueueOperation('user-a', 'project-1', 'task-1', 'item-1', percentage(60));
    expect(applyPendingOperations(base, [second, first], 'user-a', 'task-1')[0]).toMatchObject({ percentage: 60, is_completed: false });
    const third = await enqueueOperation('user-a', 'project-1', 'task-1', 'item-1', percentage(100));
    expect(applyPendingOperations(base, [third], 'user-a', 'task-1')[0]).toMatchObject({ percentage: 100, is_completed: true });
    const fourth = await enqueueOperation('user-a', 'project-1', 'task-1', 'item-1', state(false));
    expect(applyPendingOperations(base, [first, fourth], 'user-a', 'task-1')[0]).toMatchObject({ percentage: 0, is_completed: false });
  });

  it('shows the latest normalized comment', async () => {
    const a = await enqueueOperation('user-a', 'project-1', 'task-1', 'item-1', comment(' A '));
    const b = await enqueueOperation('user-a', 'project-1', 'task-1', 'item-1', comment(' B '));
    expect(applyPendingOperations(base, [a, b], 'user-a', 'task-1')[0].comment).toBe('B');
    await expect(enqueueOperation('user-a', 'project-1', 'task-1', 'item-1', comment('x'.repeat(10001)))).rejects.toThrow('10000');
  });

  it('isolates accounts and refuses writes for a different signed-in user', async () => {
    const operation = await enqueueOperation('user-a', 'project-1', 'task-1', 'item-1', percentage(70));
    storage.userId = 'user-b';
    expect(await listPendingOperations('user-b', 'task-1')).toEqual([]);
    expect(applyPendingOperations(base, [operation], 'user-b', 'task-1')[0].percentage).toBe(20);
    await expect(enqueueOperation('user-a', 'project-1', 'task-1', 'item-1', percentage(80))).rejects.toThrow('авторизация');
    storage.userId = 'user-a';
    expect((await listPendingOperations('user-a', 'task-1')).length).toBe(1);
  });

  it('does not acknowledge a failed durable write', async () => {
    storage.fail = true;
    await expect(enqueueOperation('user-a', 'project-1', 'task-1', 'item-1', percentage(70))).rejects.toThrow('storage unavailable');
    expect(storage.operations).toEqual([]);
  });
});

describe('mutation routing', () => {
  it('leaves the flag off by default and routes clean online edits to RPC', async () => {
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_WRITE_ENABLED', 'false');
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_SYNC_ENABLED', 'false');
    expect(offlineWriteEnabled()).toBe(false);
    expect(offlineSyncEnabled()).toBe(false);
    const rpc = vi.fn(async () => undefined);
    expect(await performSupportedEdit({ ...context, offline: false, edit: percentage(70), onlineAction: rpc })).toEqual({ kind: 'server' });
    expect(rpc).toHaveBeenCalledOnce();
    await expect(performSupportedEdit({ ...context, offline: true, edit: percentage(70), onlineAction: async () => { throw { message: 'Failed to fetch' }; } })).rejects.toBeTruthy();
    expect(storage.operations).toEqual([]);
  });

  it('keeps clean online edits on RPC and queues only transport failures', async () => {
    const rpc = vi.fn(async () => undefined);
    expect(await performSupportedEdit({ ...context, offline: false, edit: percentage(70), onlineAction: rpc })).toEqual({ kind: 'server' });
    expect(storage.operations).toEqual([]);
    const failure = vi.fn(async () => { throw { message: 'Failed to fetch', status: 0 }; });
    expect((await performSupportedEdit({ ...context, offline: false, edit: percentage(70), onlineAction: failure })).kind).toBe('local');
    expect(failure).toHaveBeenCalledOnce();
  });

  it('never queues authorization or business errors', async () => {
    for (const error of [{ message: 'Failed to fetch', status: 403 }, { message: 'invalid value', code: 'P0001' }]) {
      await expect(performSupportedEdit({ ...context, offline: false, edit: percentage(70), onlineAction: async () => { throw error; } })).rejects.toBe(error);
    }
    expect(storage.operations).toEqual([]);
  });

  it('keeps a dirty item local after reconnect while a clean item uses RPC', async () => {
    await enqueueOperation('user-a', 'project-1', 'task-1', 'item-1', percentage(40));
    const rpc = vi.fn(async () => undefined);
    expect((await performSupportedEdit({ ...context, offline: false, edit: percentage(70), onlineAction: rpc })).kind).toBe('local');
    expect(await performSupportedEdit({ ...context, itemId: 'item-2', offline: false, edit: percentage(70), onlineAction: rpc })).toEqual({ kind: 'server' });
    expect(rpc).toHaveBeenCalledOnce();
  });

  it('preserves old pending overlay when new offline writes are disabled', async () => {
    await enqueueOperation('user-a', 'project-1', 'task-1', 'item-1', percentage(40));
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_WRITE_ENABLED', 'false');
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_SYNC_ENABLED', 'true');
    const pending = await listPendingOperations('user-a', 'task-1');
    expect(applyPendingOperations(base, pending, 'user-a', 'task-1')[0].percentage).toBe(40);
    const rpc = vi.fn(async () => undefined);
    await expect(performSupportedEdit({ ...context, offline: false, edit: percentage(70), onlineAction: rpc })).rejects.toThrow('Сначала синхронизируйте');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not run RPC when known offline and does not claim a failed local save', async () => {
    const rpc = vi.fn(async () => undefined);
    const local = await performSupportedEdit({ ...context, offline: true, edit: state(true), onlineAction: rpc });
    expect(local.kind).toBe('local');
    expect(rpc).not.toHaveBeenCalled();
    storage.fail = true;
    await expect(performSupportedEdit({ ...context, offline: true, edit: comment('test'), onlineAction: rpc })).rejects.toThrow('storage unavailable');
  });
});
