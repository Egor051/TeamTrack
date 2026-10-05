import { describe, expect, it, vi } from 'vitest';

const { supabase } = vi.hoisted(() => ({ supabase: { from: vi.fn() } }));
vi.mock('@/lib/supabase/client', () => ({ supabase }));
vi.mock('@/features/auth/auth', () => ({ getCurrentUser: vi.fn() }));

import { getTask, listOwnedProjects, listTaskAudit } from '@/features/projects/projects';
import { getCurrentUser } from '@/features/auth/auth';
import { ResourceAccessDeniedError } from '@/lib/errors/domain-errors';
import { userMessage } from '@/lib/errors/user-message';

const taskId = '00000000-0000-4000-8000-000000000001';
const projectId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000003';

it('AUD-02: online history includes deleted-item snapshots and earlier audit events', async () => {
  const rows = [{ id: 1, project_id: projectId, entity_type: 'task_item', entity_id: 'deleted-item', action: 'updated', old_data: { percentage: 0 }, new_data: { percentage: 50 }, created_at: new Date().toISOString() },
    { id: 2, project_id: projectId, entity_type: 'task_item', entity_id: 'deleted-item', action: 'removed', old_data: { task_id: taskId }, new_data: null, created_at: new Date().toISOString() }];
  supabase.from.mockImplementation((table: string) => {
    let ids: string[] | null = null; let snapshots = false;
    const query = { select: () => query, eq: () => query, order: () => query, range: () => query,
      in: (_key: string, value: string[]) => { ids = value; return query; }, or: () => { snapshots = true; return query; },
      maybeSingle: async () => ({ data: { id: taskId }, error: null }),
      then: (resolve: (value: unknown) => void) => Promise.resolve({ data: table === 'task_items' ? [] : snapshots ? [rows[1]] : rows.filter((row) => ids?.includes(row.entity_id)), error: null }).then(resolve) };
    return query;
  });
  expect((await listTaskAudit(projectId, taskId)).map((row) => row.id).sort()).toEqual([1, 2]);
});

function taskQuery(result: { data: unknown; error: { message: string } | null }) {
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue(result) };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  supabase.from.mockReturnValue(query);
}

describe('getTask authorization outcome', () => {
  it('turns an RLS-hidden task into the domain access error without single() coercion', async () => {
    taskQuery({ data: null, error: null });
    const error = await getTask(taskId, projectId).catch((value: unknown) => value);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(error).toBeInstanceOf(ResourceAccessDeniedError);
    expect(userMessage(error, 'Не удалось загрузить данные')).toBe('Нет доступа к этапу.');
    expect(consoleError).not.toHaveBeenCalled();
    expect(supabase.from).toHaveBeenCalledWith('tasks');
    consoleError.mockRestore();
  });

  it('keeps genuine Supabase errors as unexpected errors', async () => {
    taskQuery({ data: null, error: { message: 'network request failed' } });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(getTask(taskId)).rejects.toMatchObject({ message: 'network request failed' });
    userMessage(new Error('network request failed'), 'fallback');
    expect(consoleError).toHaveBeenCalledWith('[TaskTrace]', expect.any(Error));
    consoleError.mockRestore();
  });
});

describe('listOwnedProjects ownership source', () => {
  it.each([
    ['owner alone', [{ project_id: projectId, user_id: userId, role: 'owner' }]],
    ['owner plus second member', [
      { project_id: projectId, user_id: userId, role: 'owner' },
      { project_id: projectId, user_id: '00000000-0000-4000-8000-000000000004', role: 'member' },
    ]],
    ['owner plus second and third members', [
      { project_id: projectId, user_id: userId, role: 'owner' },
      { project_id: projectId, user_id: '00000000-0000-4000-8000-000000000004', role: 'member' },
      { project_id: projectId, user_id: '00000000-0000-4000-8000-000000000005', role: 'viewer' },
    ]],
  ])('keeps the project visible with %s', async (_label, memberRows) => {
    vi.mocked(getCurrentUser).mockResolvedValue({ data: { user: { id: userId } }, error: null } as never);
    const membershipQuery = { select: vi.fn(), eq: vi.fn(), range: vi.fn() };
    membershipQuery.select.mockReturnValue(membershipQuery);
    membershipQuery.eq.mockReturnValue(membershipQuery);
    membershipQuery.range.mockResolvedValue({ data: memberRows.filter((row) => row.user_id === userId && row.role === 'owner').map(({ project_id }) => ({ project_id })), error: null });
    const projectQuery = { select: vi.fn(), in: vi.fn(), order: vi.fn(), range: vi.fn() };
    projectQuery.select.mockReturnValue(projectQuery);
    projectQuery.in.mockReturnValue(projectQuery);
    projectQuery.order.mockReturnValue(projectQuery);
    projectQuery.range.mockResolvedValue({ data: [{ id: projectId, name: 'P', status: 'active', created_at: '2026-01-01T00:00:00Z' }], error: null });
    supabase.from.mockImplementation((table: string) => table === 'project_members' ? membershipQuery : projectQuery);

    await expect(listOwnedProjects()).resolves.toMatchObject([{ id: projectId, role: 'owner' }]);
    expect(membershipQuery.eq).toHaveBeenCalledWith('role', 'owner');
    expect(membershipQuery.eq).toHaveBeenCalledWith('user_id', userId);
  });
});
