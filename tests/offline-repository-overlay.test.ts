import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineOperation } from '@/lib/local-cache/types';

const taskId = '00000000-0000-4000-8000-000000000001';
const projectId = '00000000-0000-4000-8000-000000000002';
const itemId = '00000000-0000-4000-8000-000000000003';
const state = vi.hoisted(() => ({ values: new Map<string, unknown>(), pending: [] as OfflineOperation[] }));

vi.mock('@/lib/supabase/client', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/features/auth/auth', () => ({ getCurrentUser: vi.fn() }));
vi.mock('@/lib/local-cache/cache', () => ({
  activeCacheUserId: async () => 'user-a',
  readCachedModel: async (key: string) => state.values.get(key),
  inheritCachedResult: (_source: unknown, value: unknown) => value,
  isCachedResult: () => false,
  filterBlockedProjects: vi.fn(), filterBlockedTasks: vi.fn(), getCached: vi.fn(), putCached: vi.fn(),
  reconcileVisibleProjects: vi.fn(), reconcileVisibleTasks: vi.fn(),
}));
vi.mock('@/lib/local-cache/outbox', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/local-cache/outbox')>(),
  offlineWriteEnabled: () => true,
  listPendingOperations: async (_userId: string, task?: string) => state.pending.filter((operation) => !task || operation.task_id === task),
}));

import { listTaskItems, listTasksWithStats } from '@/features/projects/projects';

beforeEach(() => {
  state.values.clear();
  const confirmed = [{ id: itemId, task_id: taskId, percentage: 20, is_completed: false, comment: null, is_archived: false }];
  state.values.set(`items:${taskId}:active`, confirmed);
  state.values.set(`task-stats:${projectId}:active`, [{ id: taskId, project_id: projectId, itemCount: 1, completedCount: 0, progressPercent: 20, assignees: [] }]);
  state.pending = [{ operation_id: 'operation-1', user_id: 'user-a', project_id: projectId, task_id: taskId,
    task_item_id: itemId, type: 'set_task_item_percentage', payload: { percentage: 70 },
    created_at: '2026-09-28T00:00:00Z', status: 'pending', sequence: 1 }];
});

describe('repository overlay', () => {
  it('reapplies pending values after repeated server reads without mutating confirmed cache', async () => {
    expect((await listTaskItems(taskId))[0].percentage).toBe(70);
    expect((state.values.get(`items:${taskId}:active`) as { percentage: number }[])[0].percentage).toBe(20);
    expect((await listTaskItems(taskId))[0].percentage).toBe(70);
  });

  it('uses effective values for stage progress statistics', async () => {
    expect(await listTasksWithStats(projectId)).toMatchObject([{ itemCount: 1, completedCount: 0, progressPercent: 70 }]);
    state.pending[0] = { ...state.pending[0], type: 'set_task_item_state', payload: { completed: true } };
    expect(await listTasksWithStats(projectId)).toMatchObject([{ itemCount: 1, completedCount: 1, progressPercent: 100 }]);
    expect((state.values.get(`task-stats:${projectId}:active`) as { progressPercent: number }[])[0].progressPercent).toBe(20);
  });
});
