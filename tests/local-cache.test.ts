import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheEntry } from '@/lib/local-cache/types';

const fixtures = vi.hoisted(() => {
  const records = new Map<string, unknown>();
  return {
    records,
    userId: 'user-a',
    writeFails: false,
    getSession: vi.fn(),
    from: vi.fn(),
    get: vi.fn(),
    put: vi.fn(),
    putIfUnchanged: vi.fn(),
    remove: vi.fn(),
  };
});

vi.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { getSession: fixtures.getSession }, from: fixtures.from },
}));
vi.mock('@/features/auth/auth', () => ({ getCurrentUser: vi.fn() }));
vi.mock('@/lib/local-cache/driver', () => ({
  localCacheDriver: { get: fixtures.get, put: fixtures.put, putIfUnchanged: fixtures.putIfUnchanged, remove: fixtures.remove },
}));

import { filterBlockedProjects, isCachedResult, readThroughCache } from '@/lib/local-cache/cache';
import { getProject, getTask, listProjectTasks, listProjects } from '@/features/projects/projects';
import { reportConnectivitySuccess } from '@/lib/connectivity/state';
import { getCurrentUser } from '@/features/auth/auth';
import { cacheAccessEpoch, confirmCacheAccess } from '@/lib/local-cache/access-state';
import { subscribeReadModelCommits } from '@/lib/local-cache/read-model-events';

const networkError = { message: 'TypeError: Failed to fetch', status: 0, code: '' };
const project = [{ id: 'project-1', name: 'Alpha' }];

beforeEach(() => {
  // Each fixture starts with independent confirmed permissions.
  for (const key of ['blocked:project-1', 'blocked:00000000-0000-4000-8000-000000000002', 'blocked-task:00000000-0000-4000-8000-000000000001'])
    confirmCacheAccess('user-a', key, cacheAccessEpoch());
  fixtures.records.clear();
  fixtures.userId = 'user-a';
  fixtures.writeFails = false;
  fixtures.getSession.mockImplementation(async () => ({
    data: { session: { user: { id: fixtures.userId }, expires_at: Math.floor(Date.now() / 1000) + 3600 } },
    error: null,
  }));
  fixtures.get.mockImplementation(async (userId: string, key: string) => fixtures.records.get(`${userId}:${key}`) ?? null);
  fixtures.put.mockImplementation(async (entry: CacheEntry) => {
    if (fixtures.writeFails) throw new Error('storage unavailable');
    fixtures.records.set(`${entry.user_id}:${entry.key}`, entry);
  });
  fixtures.putIfUnchanged.mockImplementation(async (entry: CacheEntry, expectedData: string | null) => {
    if (fixtures.writeFails) throw new Error('storage unavailable');
    const key = `${entry.user_id}:${entry.key}`;
    if (((fixtures.records.get(key) as CacheEntry | undefined)?.data ?? null) === expectedData) fixtures.records.set(key, entry);
  });
  fixtures.remove.mockImplementation(async (userId: string, key: string) => {
    fixtures.records.delete(`${userId}:${key}`);
  });
});

describe('read-through cache', () => {
  it('overview reordering does not invalidate fresh preparation; an actual project change does', async () => {
    const changed = vi.fn(); const off = subscribeReadModelCommits(changed);
    try {
      await readThroughCache('projects:active', async () => [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }]);
      changed.mockClear();
      await readThroughCache('projects:active', async () => [{ name: 'B', id: 'p2' }, { name: 'A', id: 'p1' }]);
      expect(changed).not.toHaveBeenCalled();
      await readThroughCache('projects:active', async () => [{ id: 'p1', name: 'Changed' }, { id: 'p2', name: 'B' }]);
      expect(changed).toHaveBeenCalledOnce();
    } finally { off(); }
  });
  it('returns a newer committed snapshot when an older HTTP response loses CAS, without claiming offline', async () => {
    const key = 'projects:active';
    await readThroughCache(key, async () => [{ id: 'same', name: 'initial' }]);
    let release!: (rows: { id: string; name: string }[]) => void;
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = readThroughCache(key, async () => { entered(); return new Promise<{ id: string; name: string }[]>((resolve) => { release = resolve; }); });
    await started;
    fixtures.records.set(`user-a:${key}`, { user_id: 'user-a', key, data: JSON.stringify([{ id: 'same', name: 'newer' }]), schema_version: 1 });
    release([{ id: 'same', name: 'older' }]);
    const rows = await pending;
    expect(rows).toEqual([{ id: 'same', name: 'newer' }]);
    expect(isCachedResult(rows)).toBe(false);
  });
  it.each(['active', 'archived'] as const)('AUD-11: leaving the %s list through archive/restore does not revoke cache access', async (status) => {
    const projectId = '00000000-0000-4000-8000-000000000099';
    const saved = { id: projectId, name: 'Retained', role: 'owner', status };
    await readThroughCache(`projects:${status}`, async () => [saved]);
    await readThroughCache(`project:${projectId}`, async () => saved);
    vi.mocked(getCurrentUser).mockResolvedValue({ data: { user: { id: 'user-a' } }, error: null } as Awaited<ReturnType<typeof getCurrentUser>>);
    fixtures.from.mockImplementation((table: string) => {
      const row = { ...saved, status: status === 'active' ? 'archived' : 'active' };
      let statusFilter: string | undefined;
      const query = { select: () => query, order: () => query, range: () => query, in: () => query,
        eq: (key: string, value: string) => { if (key === 'status') statusFilter = value; return query; }, then: (resolve: (value: unknown) => void) => Promise.resolve({ data: table === 'projects'
          ? statusFilter && statusFilter !== row.status ? [] : [row] : [{ project_id: projectId, role: 'owner' }], error: null }).then(resolve) };
      return query;
    });
    await listProjects(status);
    const detail = { select: () => detail, eq: () => detail, maybeSingle: async () => ({ data: null, error: networkError }) };
    fixtures.from.mockReturnValue(detail);
    expect(await getProject(projectId)).toEqual(saved);
  });
  it('returns server data and saves it with user and freshness metadata', async () => {
    const result = await readThroughCache('projects:active', async () => project);
    expect(result).toBe(project);
    expect(isCachedResult(result)).toBe(false);
    const saved = fixtures.records.get('user-a:projects:active') as CacheEntry;
    expect(saved).toMatchObject({ user_id: 'user-a', key: 'projects:active', schema_version: 1 });
    expect(JSON.parse(saved.data)).toEqual(project);
    expect(Number.isNaN(Date.parse(saved.last_synced_at))).toBe(false);
  });

  it('keeps the server result when the cache write fails', async () => {
    fixtures.writeFails = true;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(readThroughCache('projects:active', async () => project)).resolves.toBe(project);
    expect(warning).toHaveBeenCalled();
    warning.mockRestore();
  });

  it('does not overwrite a reconciled cache entry with a late old read', async () => {
    await readThroughCache('items:task:active', async () => [{ id: 'item', percentage: 20 }]);
    let finish!: (value: { id: string; percentage: number }[]) => void;
    const staleRead = readThroughCache('items:task:active', () => new Promise((resolve) => { finish = resolve; }));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    fixtures.records.set('user-a:items:task:active', {
      user_id: 'user-a', key: 'items:task:active', data: JSON.stringify([{ id: 'item', percentage: 70 }]),
      last_synced_at: '2026-09-29', schema_version: 1,
    });
    finish([{ id: 'item', percentage: 20 }]);
    await staleRead;
    expect(JSON.parse((fixtures.records.get('user-a:items:task:active') as CacheEntry).data)).toEqual([{ id: 'item', percentage: 70 }]);
  });

  it('returns saved data on transport failure', async () => {
    await readThroughCache('projects:active', async () => project);
    const result = await readThroughCache('projects:active', async () => { throw networkError; });
    expect(result).toEqual(project);
    expect(isCachedResult(result)).toBe(true);
  });

  it('preserves the offline error when there is no saved data', async () => {
    await expect(readThroughCache('projects:active', async () => { throw networkError; })).rejects.toBe(networkError);
  });

  it('never falls back for explicit access or business errors', async () => {
    await readThroughCache('projects:active', async () => project);
    const denied = { message: 'permission denied', status: 403, code: '42501' };
    const business = { message: 'network value is invalid', status: 0, code: 'P0001' };
    await expect(readThroughCache('projects:active', async () => { throw denied; })).rejects.toBe(denied);
    await expect(readThroughCache('projects:active', async () => { throw business; })).rejects.toBe(business);
  });

  it('removes a project from offline results after an explicit access denial', async () => {
    await readThroughCache('projects:active', async () => project);
    await readThroughCache('project:project-1', async () => project[0], { projectId: 'project-1' });
    const denied = { message: 'permission denied', status: 403, code: '42501' };
    await expect(readThroughCache('project:project-1', async () => { throw denied; }, { projectId: 'project-1' })).rejects.toBe(denied);
    await expect(readThroughCache('project:project-1', async () => { throw networkError; }, { projectId: 'project-1' })).rejects.toBe(networkError);
    const offlineList = await readThroughCache<typeof project>('projects:active', async () => { throw networkError; }, { filterCached: filterBlockedProjects });
    expect(offlineList).toEqual([]);
    reportConnectivitySuccess();
    await readThroughCache('project:project-1', async () => project[0], { projectId: 'project-1', clearProjectBlockOnSuccess: true });
    const restored = await readThroughCache('project:project-1', async () => { throw networkError; }, { projectId: 'project-1' });
    expect(restored).toEqual(project[0]);
  });

  it('does not save a response under the old account after a session switch', async () => {
    await readThroughCache('projects:active', async () => {
      fixtures.userId = 'user-b';
      return project;
    });
    expect(fixtures.records.has('user-a:projects:active')).toBe(false);
    expect(fixtures.records.has('user-b:projects:active')).toBe(false);
  });

  it('blocks a previously saved project when the authorized online list no longer contains it', async () => {
    const projectId = '00000000-0000-4000-8000-000000000002';
    const savedProject = { id: projectId, name: 'Old project', role: 'member' };
    await readThroughCache('projects:active', async () => [savedProject]);
    await readThroughCache(`project:${projectId}`, async () => savedProject);
    const listQuery = {
      select: vi.fn(), order: vi.fn(), range: vi.fn(), eq: vi.fn(),
      then: (resolve: (value: { data: never[]; error: null }) => void) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    listQuery.select.mockReturnValue(listQuery);
    listQuery.order.mockReturnValue(listQuery);
    listQuery.range.mockReturnValue(listQuery);
    listQuery.eq.mockReturnValue(listQuery);
    fixtures.from.mockReturnValue(listQuery);
    expect(await listProjects('active')).toEqual([]);

    const detailQuery = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: null, error: networkError })) };
    detailQuery.select.mockReturnValue(detailQuery);
    detailQuery.eq.mockReturnValue(detailQuery);
    fixtures.from.mockReturnValue(detailQuery);
    await expect(getProject(projectId)).rejects.toBe(networkError);
  });

  it('blocks a previously saved stage when the authorized online stage list no longer contains it', async () => {
    const taskId = '00000000-0000-4000-8000-000000000001';
    const projectId = '00000000-0000-4000-8000-000000000002';
    const savedTask = { id: taskId, project_id: projectId, title: 'Old stage' };
    await readThroughCache(`tasks:${projectId}`, async () => [savedTask]);
    await readThroughCache(`task:${taskId}`, async () => savedTask);
    const listQuery = {
      select: vi.fn(), eq: vi.fn(), order: vi.fn(), range: vi.fn(),
      then: (resolve: (value: { data: never[]; error: null }) => void) => Promise.resolve({ data: [], error: null }).then(resolve),
    };
    listQuery.select.mockReturnValue(listQuery);
    listQuery.eq.mockReturnValue(listQuery);
    listQuery.order.mockReturnValue(listQuery);
    listQuery.range.mockReturnValue(listQuery);
    fixtures.from.mockReturnValue(listQuery);
    expect(await listProjectTasks(projectId)).toEqual([]);

    const detailQuery = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => ({ data: null, error: networkError })) };
    detailQuery.select.mockReturnValue(detailQuery);
    detailQuery.eq.mockReturnValue(detailQuery);
    fixtures.from.mockReturnValue(detailQuery);
    await expect(getTask(taskId, projectId)).rejects.toBe(networkError);
  });

  it('isolates accounts and does not display cache after sign out', async () => {
    await readThroughCache('projects:active', async () => project);
    fixtures.userId = 'user-b';
    await expect(readThroughCache('projects:active', async () => { throw networkError; })).rejects.toBe(networkError);
    fixtures.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(readThroughCache('projects:active', async () => { throw networkError; })).rejects.toThrow('Network unavailable');
  });

  it('serves a cached stage through the existing project repository', async () => {
    const taskId = '00000000-0000-4000-8000-000000000001';
    const projectId = '00000000-0000-4000-8000-000000000002';
    const task = { id: taskId, project_id: projectId, title: 'Stage' };
    let response: { data: typeof task | null; error: typeof networkError | null } = { data: task, error: null };
    const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => response) };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    fixtures.from.mockReturnValue(query);
    expect(await getTask(taskId, projectId)).toEqual(task);
    response = { data: null, error: networkError };
    const offline = await getTask(taskId, projectId);
    expect(offline).toEqual(task);
    expect(isCachedResult(offline)).toBe(true);
    response = { data: null, error: { message: 'permission denied', status: 403, code: '42501' } };
    reportConnectivitySuccess();
    await expect(getTask(taskId, projectId)).rejects.toMatchObject({ status: 403 });
  });

  it('reads a saved entry after a simulated app restart', async () => {
    await readThroughCache('projects:active', async () => project);
    vi.resetModules();
    const restarted = await import('@/lib/local-cache/cache');
    const result = await restarted.readThroughCache('projects:active', async () => { throw networkError; });
    expect(result).toEqual(project);
    expect(restarted.isCachedResult(result)).toBe(true);
  });
});
