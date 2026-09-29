import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineOperation } from '@/lib/local-cache/types';

const state = vi.hoisted(() => ({
  userId: 'user-a', operations: [] as OfflineOperation[], calls: [] as string[], applied: new Set<string>(),
  rpc: vi.fn(), read: vi.fn(), failMark: false, failReconcile: false, tokens: [] as string[],
}));

vi.mock('@/lib/supabase/client', () => ({ supabase: {
  auth: { getSession: async () => ({ data: { session: { user: { id: state.userId }, access_token: `token-${state.userId}` } }, error: null }) },
  from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ order: () => ({ range: () => state.read() }) }) }) }) }) }),
} }));
vi.mock('@supabase/supabase-js', () => ({ createClient: (_url: string, _key: string, options: { accessToken: () => Promise<string> }) => ({
  rpc: async (...args: unknown[]) => {
    state.tokens.push(await options.accessToken());
    return state.rpc(...args);
  },
  from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ order: () => ({ range: () => state.read() }) }) }) }) }) }),
}) }));
vi.mock('@/lib/env', () => ({ supabaseEnv: () => ({ url: 'http://local.test', anonKey: 'public-key' }) }));
vi.mock('@/lib/local-cache/cache', () => ({
  activeCacheUserId: async () => state.userId,
  isTransportFailure: (error: { message?: string }) => /failed to fetch/i.test(error.message ?? ''),
}));
vi.mock('@/lib/local-cache/driver', () => ({ localCacheDriver: {
  markOperation: async (userId: string, operationId: string, status: OfflineOperation['status'], result?: unknown, error?: string) => {
    if (state.failMark) throw new Error('storage unavailable');
    const operation = state.operations.find((row) => row.user_id === userId && row.operation_id === operationId);
    if (operation) Object.assign(operation, { status, server_result: result, last_error: error });
  },
  reconcileOperation: async (userId: string, operationId: string) => {
    if (state.failReconcile) throw new Error('storage unavailable');
    const index = state.operations.findIndex((row) => row.user_id === userId && row.operation_id === operationId);
    if (index >= 0) state.operations.splice(index, 1);
  },
} }));
vi.mock('@/lib/local-cache/outbox', () => ({
  offlineSyncEnabled: () => true,
  listPendingOperations: async (userId: string) => state.operations.filter((row) => row.user_id === userId)
    .sort((a, b) => a.sequence - b.sequence),
}));

import { syncPendingOperations } from '@/lib/local-cache/sync';

function operation(sequence: number, type: OfflineOperation['type'], payload: OfflineOperation['payload']): OfflineOperation {
  return { sequence, operation_id: `operation-${sequence}`, user_id: 'user-a', project_id: 'project', task_id: 'task',
    task_item_id: 'item', type, payload, created_at: '2026-09-29T00:00:00Z', status: 'pending' };
}

beforeEach(() => {
  state.userId = 'user-a';
  state.operations = [];
  state.calls = [];
  state.tokens = [];
  state.applied.clear();
  state.failMark = false;
  state.failReconcile = false;
  state.rpc.mockReset();
  state.read.mockReset().mockResolvedValue({ data: [{ id: 'item', percentage: 70, is_completed: false, comment: null }], error: null });
  state.rpc.mockImplementation(async (_name: string, args: { p_operation_id: string }) => {
    state.calls.push(args.p_operation_id);
    state.applied.add(args.p_operation_id);
    return { data: 70, error: null };
  });
});

describe('offline replay', () => {
  it('replays state and percentage edits in sequence with the expected final state', async () => {
    state.operations = [
      operation(1, 'set_task_item_percentage', { percentage: 40 }),
      operation(2, 'set_task_item_state', { completed: true }),
      operation(3, 'set_task_item_percentage', { percentage: 60 }),
    ];
    const server = { percentage: 0, is_completed: false };
    state.rpc.mockImplementation(async (name: string, args: { p_operation_id: string; p_percentage?: number; p_completed?: boolean }) => {
      state.calls.push(args.p_operation_id);
      if (name === 'apply_task_item_state_operation') {
        server.is_completed = args.p_completed!;
        server.percentage = args.p_completed ? 100 : 0;
        return { data: server.is_completed, error: null };
      }
      server.percentage = args.p_percentage!;
      server.is_completed = server.percentage === 100;
      return { data: server.percentage, error: null };
    });
    state.read.mockImplementation(async () => ({ data: [{ id: 'item', ...server, comment: null }], error: null }));
    await syncPendingOperations('user-a');
    expect(state.calls).toEqual(['operation-1', 'operation-2', 'operation-3']);
    expect(server).toEqual({ percentage: 60, is_completed: false });
    expect(state.operations).toEqual([]);
  });

  it('retries a lost ACK with the same ID and one server action', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 70 })];
    let first = true;
    state.rpc.mockImplementation(async (_name: string, args: { p_operation_id: string }) => {
      state.calls.push(args.p_operation_id);
      state.applied.add(args.p_operation_id);
      if (first) { first = false; throw new Error('Failed to fetch'); }
      return { data: 70, error: null };
    });
    await syncPendingOperations('user-a');
    expect(state.calls).toEqual(['operation-1', 'operation-1']);
    expect(state.applied.size).toBe(1);
    expect(state.operations).toEqual([]);
  });

  it('stops after uncertain oldest result and recovers on a later trigger', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 40 }), operation(2, 'set_task_item_state', { completed: true })];
    state.rpc.mockRejectedValue(new Error('Failed to fetch'));
    await syncPendingOperations('user-a');
    expect(state.calls).toEqual([]);
    expect(state.rpc).toHaveBeenCalledTimes(3);
    expect(state.operations[0].status).toBe('pending');
    expect(state.operations[0].operation_id).toBe('operation-1');
    state.rpc.mockImplementation(async (_name: string, args: { p_operation_id: string }) => {
      state.calls.push(args.p_operation_id);
      return { data: 40, error: null };
    });
    await syncPendingOperations('user-a');
    expect(state.calls).toEqual(['operation-1', 'operation-2']);
  });

  it('recovers after ACK before reconciliation without another mutation', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 70 })];
    state.failReconcile = true;
    await syncPendingOperations('user-a');
    expect(state.operations[0].status).toBe('synced_unreconciled');
    expect(state.rpc).toHaveBeenCalledOnce();
    state.failReconcile = false;
    await syncPendingOperations('user-a');
    expect(state.rpc).toHaveBeenCalledOnce();
    expect(state.operations).toEqual([]);
  });

  it('keeps a retryable operation when local ACK persistence fails', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 70 })];
    state.failMark = true;
    await expect(syncPendingOperations('user-a')).rejects.toThrow('storage unavailable');
    expect(state.operations[0].status).toBe('pending');
    state.failMark = false;
    await syncPendingOperations('user-a');
    expect(state.calls).toEqual(['operation-1', 'operation-1']);
    expect(state.operations).toEqual([]);
  });

  it('keeps a server rejection durable and blocks later sequence', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 40 }), operation(2, 'set_task_item_state', { completed: true })];
    state.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'no access' } });
    await syncPendingOperations('user-a');
    expect(state.operations.map((row) => row.status)).toEqual(['failed', 'pending']);
    expect(state.operations[0].last_error).toBe('no access');
    expect(state.rpc).toHaveBeenCalledOnce();
  });

  it('stops when the signed-in user changes', async () => {
    state.operations = [operation(1, 'set_task_item_percentage', { percentage: 70 })];
    state.rpc.mockImplementation(async () => {
      state.userId = 'user-b';
      return { data: 70, error: null };
    });
    await syncPendingOperations('user-a');
    expect(state.operations[0].status).toBe('pending');
    expect(state.tokens).toEqual(['token-user-a']);
  });
});
