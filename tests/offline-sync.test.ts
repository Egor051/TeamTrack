import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheEntry, OfflineOperation, PullChange, SyncConflict } from '@/lib/local-cache/types';

const state = vi.hoisted(() => ({
  userId: 'user-a', operations: [] as OfflineOperation[], conflicts: [] as SyncConflict[],
  server: { id: 'item', task_id: 'task', title: 'Item', percentage: 20, is_completed: false,
    comment: null as string | null, sync_version: 10, is_archived: false },
  calls: [] as { name: string; id: string; expected: number }[], receipts: new Map<string, unknown>(),
  sideEffects: 0, loseAck: false, failAck: false, failReconcile: false, tokens: [] as string[],
  localCursor: 0 as number | null, entries: [] as CacheEntry[], pulled: [] as PullChange[],
  bootstrapChange: false, pullRequests: [] as number[],
  configSync: true, configAvailable: true,
  switchAfterSend: false,
}));

const builder = () => {
  const fetchPage = async () => {
    const snapshot = { ...state.server };
    if (state.bootstrapChange) {
      state.bootstrapChange = false;
      state.server.percentage = 80; state.server.sync_version = 11;
      state.pulled = [{ cursor: 1, task_id: 'task', task_item_id: 'item', change_type: 'upsert', item: { ...state.server } }];
    }
    return { data: [snapshot], error: null };
  };
  const query = {
    select: () => query, eq: () => query, order: () => query,
    range: () => query,
    then: (onFulfilled: (value: Awaited<ReturnType<typeof fetchPage>>) => unknown) => fetchPage().then(onFulfilled),
    maybeSingle: async () => ({ data: { ...state.server }, error: null }),
  };
  return query;
};

vi.mock('@/lib/supabase/client', () => ({ supabase: {
  auth: { getSession: async () => ({ data: { session: { user: { id: state.userId }, access_token: `token-${state.userId}` } }, error: null }) },
} }));
vi.mock('@supabase/supabase-js', () => ({ createClient: (_url: string, _key: string, options: { accessToken: () => Promise<string> }) => ({
  rpc: async (name: string, args: { p_operation_id?: string; p_expected_version?: number; p_percentage?: number; p_completed?: boolean; p_comment?: string; p_after_cursor?: number }) => {
    state.tokens.push(await options.accessToken());
    if (name === 'pull_task_item_changes_v2') {
      const cursor = args.p_after_cursor!;
      state.pullRequests.push(cursor);
      const changes = state.pulled.filter((change) => change.cursor > cursor);
      return { data: { changes, next_cursor: changes.at(-1)?.cursor ?? cursor, has_more: false }, error: null };
    }
    if (name === 'get_task_item_sync_cursor') return { data: 0, error: null };
    state.calls.push({ name, id: args.p_operation_id!, expected: args.p_expected_version! });
    if (state.receipts.has(args.p_operation_id!)) return { data: state.receipts.get(args.p_operation_id!), error: null };
    if (args.p_expected_version !== state.server.sync_version)
      return { data: { status: 'conflict', version: state.server.sync_version, item: { ...state.server } }, error: null };
    if (name.includes('percentage')) {
      state.server.percentage = args.p_percentage!;
      state.server.is_completed = args.p_percentage === 100;
    } else if (name.includes('state')) {
      state.server.is_completed = args.p_completed!;
      state.server.percentage = args.p_completed ? 100 : 0;
    } else state.server.comment = args.p_comment || null;
    state.server.sync_version += 1;
    state.sideEffects += 1;
    const result = { status: 'applied', version: state.server.sync_version, item: { ...state.server } };
    state.receipts.set(args.p_operation_id!, result);
    if (state.switchAfterSend) { state.switchAfterSend = false; state.userId = 'user-b'; }
    if (state.loseAck) { state.loseAck = false; throw new Error('Failed to fetch'); }
    return { data: result, error: null };
  },
  from: builder,
}) }));
vi.mock('@/lib/env', () => ({ supabaseEnv: () => ({ url: 'http://local.test', anonKey: 'public-key' }) }));
vi.mock('@/lib/local-cache/cache', () => ({
  activeCacheUserId: async () => state.userId,
  isTransportFailure: (error: { message?: string }) => /failed to fetch/i.test(error.message ?? ''),
}));
vi.mock('@/lib/local-cache/runtime-config', () => ({
  RUNTIME_CONFIG_TTL_MS: 60_000,
  runtimeCapabilities: async () => ({ write: state.configSync, sync: state.configSync, available: state.configAvailable }),
}));
vi.mock('@/lib/local-cache/status', () => ({
  updateSyncState: () => undefined, notifySyncState: () => undefined,
  markSuccessfulSync: async () => undefined,
}));
vi.mock('@/lib/local-cache/driver', () => ({ localCacheDriver: {
  get: async () => state.localCursor === null ? null : { data: JSON.stringify(state.localCursor) },
  initializePullCursor: async (_userId: string, cursor: number) => {
    if (state.localCursor !== null) return false;
    state.localCursor = cursor;
    return true;
  },
  applyPullPage: async (_userId: string, after: number, next: number, changes: PullChange[]) => {
    if (state.localCursor !== after) return false;
    const last = changes.at(-1)?.item;
    if (last) state.entries[0].data = JSON.stringify([last]);
    state.localCursor = next;
    return true;
  },
  listEntries: async () => state.entries,
  putIfUnchanged: async (entry: CacheEntry, oldData: string) => {
    const current = state.entries.find((row) => row.key === entry.key);
    if (current?.data !== oldData) return false;
    current.data = entry.data;
    return true;
  },
  remove: async () => undefined,
  listConflicts: async (userId: string) => state.conflicts.filter((row) => row.user_id === userId),
  createConflict: async (conflict: SyncConflict) => {
    const index = state.conflicts.findIndex((row) => row.conflict_id === conflict.conflict_id);
    if (index >= 0) state.conflicts[index] = conflict; else state.conflicts.push(conflict);
    for (const row of state.operations) if (conflict.operation_ids.includes(row.operation_id)) row.status = 'conflict';
  },
  rebaseConflict: async (_userId: string, conflictId: string, version: number) => {
    const conflict = state.conflicts.find((row) => row.conflict_id === conflictId)!;
    const first = state.operations.filter((row) => conflict.operation_ids.includes(row.operation_id))
      .sort((a, b) => a.sequence - b.sequence).find((row) => row.status !== 'synced_unreconciled');
    for (const row of state.operations) if (conflict.operation_ids.includes(row.operation_id)) {
      if (row.status === 'synced_unreconciled') continue;
      row.status = 'pending';
      if (row.operation_id === first?.operation_id) row.expected_version = version;
    }
  },
  finishMineConflict: async (_userId: string, conflictId: string) => {
    state.conflicts = state.conflicts.filter((row) => row.conflict_id !== conflictId);
  },
  resolveServerConflict: async (_userId: string, conflictId: string) => {
    const conflict = state.conflicts.find((row) => row.conflict_id === conflictId)!;
    state.operations = state.operations.filter((row) => !conflict.operation_ids.includes(row.operation_id));
    state.conflicts = state.conflicts.filter((row) => row.conflict_id !== conflictId);
  },
  markOperation: async (userId: string, operationId: string, status: OfflineOperation['status'], _result?: unknown, error?: string) => {
    const row = state.operations.find((operation) => operation.user_id === userId && operation.operation_id === operationId);
    if (row) { row.status = status; row.last_error = error; }
  },
  acknowledgeOperation: async (userId: string, operationId: string, version: number, conflictId?: string, item?: unknown) => {
    if (state.failAck) throw new Error('storage unavailable');
    const row = state.operations.find((operation) => operation.user_id === userId && operation.operation_id === operationId)!;
    row.status = 'synced_unreconciled'; row.server_version = version;
    for (const following of state.operations) if (following.depends_on_operation_id === operationId) {
      following.expected_version = version;
      following.depends_on_operation_id = null;
    }
    const conflict = state.conflicts.find((entry) => entry.conflict_id === conflictId);
    if (conflict && item) { conflict.server_state = item as SyncConflict['server_state']; conflict.server_version = version; }
  },
  reconcileOperation: async (userId: string, operationId: string) => {
    if (state.failReconcile) throw new Error('storage unavailable');
    state.operations = state.operations.filter((row) => row.user_id !== userId || row.operation_id !== operationId);
  },
} }));
vi.mock('@/lib/local-cache/outbox', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/local-cache/outbox')>(),
  offlineSyncEnabled: () => true,
  listPendingOperations: async (userId: string) => state.operations.filter((row) => row.user_id === userId)
    .sort((a, b) => a.sequence - b.sequence),
}));

import { chooseMine, syncPendingOperations } from '@/lib/local-cache/sync';
import { chooseServer, unresolvedConflicts } from '@/lib/local-cache/conflicts';

function operation(sequence: number, type: OfflineOperation['type'], payload: OfflineOperation['payload']): OfflineOperation {
  return { sequence, operation_id: `operation-${sequence}`, user_id: 'user-a', project_id: 'project', task_id: 'task',
    task_item_id: 'item', type, payload, created_at: '2026-09-29T00:00:00Z', status: 'pending',
    expected_version: sequence === 1 ? 10 : null, depends_on_operation_id: sequence === 1 ? null : `operation-${sequence - 1}` };
}

beforeEach(() => {
  state.userId = 'user-a'; state.operations = []; state.conflicts = [];
  state.server = { id: 'item', task_id: 'task', title: 'Item', percentage: 20, is_completed: false,
    comment: null, sync_version: 10, is_archived: false };
  state.calls = []; state.receipts.clear(); state.sideEffects = 0;
  state.loseAck = false; state.failAck = false; state.failReconcile = false; state.tokens = [];
  state.localCursor = 0; state.entries = []; state.pulled = []; state.bootstrapChange = false; state.pullRequests = [];
  state.configSync = true; state.configAvailable = true;
  state.switchAfterSend = false;
});

describe('Phase 5 offline replay', () => {
  it('automatically retries queued work after a config-fetch backoff expires', async () => {
    vi.useFakeTimers();
    try {
      state.operations = [operation(1, 'set_task_item_percentage', { percentage: 40 })];
      state.configSync = false; state.configAvailable = false;
      await syncPendingOperations('user-a');
      expect(state.calls).toEqual([]);
      state.configSync = true; state.configAvailable = true;
      await vi.advanceTimersByTimeAsync(5_100);
      expect(state.operations).toEqual([]);
      expect(state.server.percentage).toBe(40);
    } finally { vi.useRealTimers(); }
  });
  it('replays 500 ordered operations with one idempotent mutation per ID', async () => {
    state.operations = Array.from({ length: 500 }, (_, index) =>
      operation(index + 1, 'set_task_item_percentage', { percentage: (index + 1) % 101 }));
    await syncPendingOperations('user-a', true);
    expect(state.calls).toHaveLength(500);
    expect(state.calls.map((call) => call.expected)).toEqual(Array.from({ length: 500 }, (_, index) => index + 10));
    expect(state.sideEffects).toBe(500);
    expect(state.operations).toEqual([]);
  });

  it('quarantines an unknown operation type without sending it', async () => {
    state.operations = [{ ...operation(1, 'set_task_item_comment', { comment: 'Local' }),
      type: 'future_operation' as OfflineOperation['type'], protocol_version: 3 }];
    await syncPendingOperations('user-a', true);
    expect(state.calls).toEqual([]);
    expect(state.operations[0].status).toBe('failed');
  });
  it('replays a server change committed during initial cache bootstrap', async () => {
    state.localCursor = null;
    state.entries = [{ user_id: 'user-a', key: 'items:task:active',
      data: JSON.stringify([{ ...state.server }]), last_synced_at: '2026-09-29', schema_version: 1 }];
    state.bootstrapChange = true;
    await syncPendingOperations('user-a', true);
    expect(state.pullRequests[0]).toBe(0);
    expect(state.localCursor).toBe(1);
    expect(JSON.parse(state.entries[0].data)[0]).toMatchObject({ percentage: 80, sync_version: 11 });
  });

  it('uses returned versions across a durable three-operation chain', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 40 }),
      operation(2, 'set_task_item_state', { completed: true }),
      operation(3, 'set_task_item_percentage', { percentage: 60 })];
    await syncPendingOperations('user-a');
    expect(state.calls.map((call) => call.expected)).toEqual([10, 11, 12]);
    expect(state.server).toMatchObject({ percentage: 60, sync_version: 13 });
    expect(state.operations).toEqual([]);
  });

  it('uses the advanced version after an accepted semantic no-op', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 20 }),
      operation(2, 'set_task_item_comment', { comment: 'Local note' })];
    await syncPendingOperations('user-a');
    expect(state.calls.map((call) => call.expected)).toEqual([10, 11]);
    expect(state.server).toMatchObject({ percentage: 20, comment: 'Local note', sync_version: 12 });
    expect(state.operations).toEqual([]);
  });

  it('retries a lost ACK with one server mutation and no false conflict', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 70 })];
    state.loseAck = true;
    await syncPendingOperations('user-a');
    expect(state.calls.map((call) => call.id)).toEqual(['operation-1', 'operation-1']);
    expect(state.sideEffects).toBe(1);
    expect(state.conflicts).toEqual([]);
    expect(state.operations).toEqual([]);
  });

  it('persists the full local chain on version conflict without overwriting server', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 40 }),
      operation(2, 'set_task_item_percentage', { percentage: 70 })];
    state.server.percentage = 100; state.server.is_completed = true; state.server.sync_version = 11;
    await syncPendingOperations('user-a');
    expect(state.server.percentage).toBe(100);
    expect(state.sideEffects).toBe(0);
    expect(state.conflicts[0]).toMatchObject({ operation_ids: ['operation-1', 'operation-2'],
      server_version: 11, local_effective_state: { percentage: 70 }, server_state: { percentage: 100 } });
    expect(state.operations.map((row) => row.status)).toEqual(['conflict', 'conflict']);
  });

  it('replays original chain after keep mine, with a fresh version check', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 40 }),
      operation(2, 'set_task_item_percentage', { percentage: 70 })];
    state.server.percentage = 100; state.server.is_completed = true; state.server.sync_version = 11;
    await syncPendingOperations('user-a');
    await chooseMine('user-a', state.conflicts[0].conflict_id);
    expect(state.calls.map((call) => call.expected)).toEqual([10, 11, 12]);
    expect(state.server).toMatchObject({ percentage: 70, sync_version: 13 });
    expect(state.conflicts).toEqual([]);
  });

  it('keeps the gate when server changes again before keep mine', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 70 })];
    state.server.percentage = 100; state.server.sync_version = 11;
    await syncPendingOperations('user-a');
    state.server.percentage = 30; state.server.sync_version = 12;
    await expect(chooseMine('user-a', state.conflicts[0].conflict_id)).rejects.toThrow('Не удалось применить');
    expect(state.conflicts[0].server_version).toBe(12);
    expect(state.server.percentage).toBe(30);
  });

  it('retains the latest confirmed server snapshot if replay pauses after an ACK', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 40 }),
      operation(2, 'set_task_item_percentage', { percentage: 70 })];
    state.server.percentage = 100; state.server.sync_version = 11;
    await syncPendingOperations('user-a');
    const id = state.conflicts[0].conflict_id;
    state.failReconcile = true;
    await expect(chooseMine('user-a', id)).rejects.toThrow('Не удалось применить');
    expect(state.conflicts[0]).toMatchObject({ server_version: 12, server_state: { percentage: 40 } });
    expect(state.operations[0].status).toBe('synced_unreconciled');
    state.failReconcile = false;
    await chooseMine('user-a', id);
    expect(state.server.percentage).toBe(70);
    expect(state.conflicts).toEqual([]);
  });

  it('safely discards a conflicted chain after keep server', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 70 })];
    state.server.percentage = 100; state.server.sync_version = 11;
    await syncPendingOperations('user-a');
    await chooseServer('user-a', state.conflicts[0].conflict_id);
    expect(state.operations).toEqual([]);
    expect(await unresolvedConflicts('user-a')).toEqual([]);
    expect(state.sideEffects).toBe(0);
  });

  it('never sends a legacy unversioned row through a conflict-aware RPC', async () => {
    state.operations = [{ ...operation(1, 'set_task_item_comment', { comment: 'Local' }), expected_version: undefined }];
    await syncPendingOperations('user-a');
    expect(state.calls).toEqual([]);
    expect(state.conflicts[0].conflicting_fields).toEqual(['comment']);
  });

  it('keeps a retryable row if durable ACK fails', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 70 })];
    state.failAck = true;
    await expect(syncPendingOperations('user-a')).rejects.toThrow('storage unavailable');
    expect(state.operations[0].status).toBe('pending');
    state.failAck = false;
    await syncPendingOperations('user-a', true);
    expect(state.sideEffects).toBe(1);
    expect(state.operations).toEqual([]);
  });

  it('never persists an ACK after the authenticated user changes', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 70 })];
    state.userId = 'user-b';
    await syncPendingOperations('user-a');
    expect(state.calls).toEqual([]);
    expect(state.operations[0].status).toBe('pending');
  });

  it('keeps the old account operation after a mid-send account switch and dedupes on return', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 70 })];
    state.switchAfterSend = true;
    await syncPendingOperations('user-a');
    expect(state.sideEffects).toBe(1);
    expect(state.operations[0].status).toBe('pending');
    expect(state.tokens.every((token) => token === 'token-user-a')).toBe(true);
    state.userId = 'user-a';
    await syncPendingOperations('user-a', true);
    expect(state.sideEffects).toBe(1);
    expect(state.operations).toEqual([]);
  });
});
