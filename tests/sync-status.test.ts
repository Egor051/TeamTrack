import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineOperation } from '@/lib/local-cache/types';

const store = vi.hoisted(() => ({ userId: 'user-a', operations: vi.fn(), conflicts: vi.fn(), get: vi.fn() }));
vi.mock('@/lib/local-cache/cache', () => ({ activeCacheUserId: async () => store.userId }));
vi.mock('@/lib/local-cache/outbox', () => ({ listPendingOperations: store.operations }));
vi.mock('@/lib/local-cache/conflicts', () => ({ unresolvedConflicts: store.conflicts }));
vi.mock('@/lib/local-cache/driver', () => ({ localCacheDriver: { get: store.get } }));
import { forgetSyncState, getSyncState, updateSyncState } from '@/lib/local-cache/status';

beforeEach(() => {
  store.userId = 'user-a'; store.operations.mockResolvedValue([]); store.conflicts.mockResolvedValue([]); store.get.mockResolvedValue(null);
  forgetSyncState('user-a');
});
describe('unsynced operation lifecycle count', () => {
  it('counts all four outbox statuses including every operation in a conflict chain', async () => {
    const statuses = ['pending', 'synced_unreconciled', 'failed', 'conflict', 'conflict'] as const;
    store.operations.mockResolvedValue(statuses.map((status, sequence) => ({ status, sequence })) as OfflineOperation[]);
    store.conflicts.mockResolvedValue([{ operation_ids: ['conflict-op-1', 'conflict-op-2'] }]);
    expect(await getSyncState('user-a')).toMatchObject({ unsyncedCount: 5, pendingCount: 2, failedCount: 1, conflictCount: 1 });
  });
  it('stops counting reconciled/deleted operations and never counts a conflict item as an operation', async () => {
    store.operations.mockResolvedValue([{ status: 'pending' }]);
    expect((await getSyncState('user-a')).unsyncedCount).toBe(1);
    store.operations.mockResolvedValue([]); store.conflicts.mockResolvedValue([{}]);
    expect((await getSyncState('user-a')).unsyncedCount).toBe(0);
  });
  it('keeps connectivity and pass activity separate from durable operation counts', async () => {
    updateSyncState('user-a', { connectivity: 'offline', isSyncing: false });
    store.operations.mockResolvedValue([{ status: 'pending' }, { status: 'failed' }]);
    expect(await getSyncState('user-a')).toMatchObject({ connectivity: 'offline', unsyncedCount: 2, failedCount: 1 });
  });
  it('rejects a different account and a session change during storage reads', async () => {
    await expect(getSyncState('user-b')).rejects.toThrow('Требуется авторизация');
    store.get.mockImplementation(async () => { store.userId = 'user-b'; return null; });
    await expect(getSyncState('user-a')).rejects.toThrow('Сеанс изменился');
  });
});
