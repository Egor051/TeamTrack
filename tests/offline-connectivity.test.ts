import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ user: 'user-a' as string | null, session: vi.fn(), persisted: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { auth: { getSession: f.session }, from: f.from }, readPersistedSession: f.persisted }));
vi.mock('@/lib/local-cache/driver', async () => import('@/lib/local-cache/driver.web'));
vi.mock('@/features/auth/auth', async () => {
  const { getReadSession } = await import('@/lib/supabase/session');
  return { getCurrentUser: async () => {
    const { data, error } = await getReadSession();
    return { data: { user: data.session?.user ?? null }, error };
  } };
});
import { readThroughCache, putCached, isCachedResult, isTransportFailure } from '@/lib/local-cache/cache';
import { getReadSession } from '@/lib/supabase/session';
import { getConnectivityState, reportConnectivitySuccess, monitorConnectivity, revalidateConnectivity,
  reportConnectivityFailure, CONNECTIVITY_PROBE_INTERVAL_MS } from '@/lib/connectivity/state';
import { connectivityFetch, AUTH_REVALIDATION_TIMEOUT_MS } from '@/lib/connectivity/fetch';
import { uiRead } from '@/lib/supabase/ui-read';
import { PostgrestClient } from '@supabase/postgrest-js';
import { AbortController as NativeAbortController } from 'abort-controller';
import { probeSupabase } from '@/lib/supabase/connectivity-probe';
import { GoTrueClient } from '@supabase/auth-js';
import { listProjectDailyProgress, getUtcPlus3DayStart } from '@/features/projects/projects';

beforeEach(async () => {
  f.from.mockReset();
  f.user = 'user-a'; vi.stubGlobal('navigator', { onLine: true });
  f.persisted.mockImplementation(async () => f.user ? { user: { id: f.user }, expires_at: 1 } : null);
  f.session.mockImplementation(async () => ({ data: { session: f.user ? { user: { id: f.user }, expires_at: Date.now() / 1000 + 3600 } : null }, error: null }));
  await new Promise<void>((resolve) => { const request = indexedDB.deleteDatabase('tasktrace-local-cache'); request.onsuccess = () => resolve(); });
  await putCached('user-a', 'projects:active', [{ id: 'project-a' }]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('automatic cache read connectivity', () => {
  it('manual recovery replaces a hung probe and ignores its late success', async () => {
    let release!: () => void; const hung = new Promise<void>((resolve) => { release = resolve; });
    const probe = vi.fn().mockImplementationOnce(() => hung).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(undefined);
    const cleanup = monitorConnectivity(probe);
    try {
      reportConnectivityFailure(new TypeError('Failed to fetch'));
      const old = revalidateConnectivity();
      await Promise.resolve();
      await revalidateConnectivity(true);
      expect(getConnectivityState()).toBe('degraded');
      release(); await old;
      expect(getConnectivityState()).toBe('degraded');
      await revalidateConnectivity(true);
      expect(getConnectivityState()).toBe('online');
    } finally { cleanup(); }
  });
  it('known offline reads real IndexedDB without invoking either network read or SDK session refresh', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const online = vi.fn(() => new Promise<never>(() => undefined));
    const result = await readThroughCache('projects:active', online);
    expect(result).toEqual([{ id: 'project-a' }]); expect(isCachedResult(result)).toBe(true);
    expect(online).not.toHaveBeenCalled(); expect(f.session).not.toHaveBeenCalled();
    expect(getConnectivityState()).toBe('offline');
  });
  it('missing cache, logout and another account return errors immediately without network', async () => {
    vi.stubGlobal('navigator', { onLine: false }); const online = vi.fn();
    await expect(readThroughCache('missing', online)).rejects.toThrow('Network unavailable');
    f.user = 'user-b'; await expect(readThroughCache('projects:active', online)).rejects.toThrow();
    f.user = null; await expect(readThroughCache('projects:active', online)).rejects.toThrow();
    expect(online).not.toHaveBeenCalled();
  });
  it('keeps online reads authoritative and writes the fresh confirmation', async () => {
    const online = vi.fn(async () => [{ id: 'fresh' }]);
    expect(await readThroughCache('projects:active', online)).toEqual([{ id: 'fresh' }]);
    expect(online).toHaveBeenCalledOnce(); expect(getConnectivityState()).toBe('online');
  });
  it('first transport failure falls back and the following route does no network work', async () => {
    const first = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await readThroughCache('projects:active', first)).toEqual([{ id: 'project-a' }]);
    expect(getConnectivityState()).toBe('degraded');
    const next = vi.fn(); expect(await readThroughCache('projects:active', next)).toEqual([{ id: 'project-a' }]);
    expect(next).not.toHaveBeenCalled();
  });
  it('shares one bounded recovery probe, does not probe per read, and restores network reads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); const probe = vi.fn(async () => undefined); const cleanup = monitorConnectivity(probe);
    try {
      reportConnectivityFailure(new TypeError('Failed to fetch'));
      await Promise.all([readThroughCache('projects:active', vi.fn()), readThroughCache('projects:active', vi.fn())]);
      expect(probe).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(CONNECTIVITY_PROBE_INTERVAL_MS);
      expect(probe).toHaveBeenCalledOnce(); expect(getConnectivityState()).toBe('online');
      const online = vi.fn(async () => []); await readThroughCache('projects:active', online); expect(online).toHaveBeenCalledOnce();
      reportConnectivityFailure(new TypeError('Failed to fetch'));
      await Promise.all([revalidateConnectivity(), revalidateConnectivity()]); expect(probe).toHaveBeenCalledTimes(2);
    } finally { cleanup(); }
  });
  it.each([401, 403])('server %i cannot be replaced with an existing cached resource', async (status) => {
    const denied = { status, message: 'Denied' };
    await expect(readThroughCache('projects:active', async () => { throw denied; })).rejects.toBe(denied);
    expect(getConnectivityState()).toBe('online');
    vi.stubGlobal('navigator', { onLine: false });
    await expect(readThroughCache('projects:active', vi.fn())).rejects.toThrow();
  });
  it('preserves resource revocation and catches an account switch during local filtering', async () => {
    await putCached('user-a', 'blocked:project-a', true); vi.stubGlobal('navigator', { onLine: false });
    await expect(readThroughCache('projects:active', vi.fn(), { projectId: 'project-a' })).rejects.toThrow();
    await expect(readThroughCache('projects:active', vi.fn(), { filterCached: async (_user, value) => { f.user = 'user-b'; return value; } })).rejects.toThrow();
  });
  it('expired persisted session opens offline reads without waiting for SDK refresh', async () => {
    vi.stubGlobal('navigator', { onLine: false }); f.session.mockImplementation(() => new Promise(() => undefined));
    expect((await getReadSession()).data.session?.user.id).toBe('user-a');
    expect(f.session).not.toHaveBeenCalled();
  });
  it('offline progress derives cached tasks/items/audit without entering a bulk SDK query or refresh', async () => {
    const projectId = '11111111-1111-4111-8111-111111111111';
    const taskId = '22222222-2222-4222-8222-222222222222';
    const itemId = '33333333-3333-4333-8333-333333333333';
    await putCached('user-a', `tasks:${projectId}`, [{ id: taskId, project_id: projectId, title: 'Cached stage', position: 0 }]);
    await putCached('user-a', `task:${taskId}`, { id: taskId, project_id: projectId });
    await putCached('user-a', `items:${taskId}:all`, [{ id: itemId, task_id: taskId, title: 'Cached item', position: 0, percentage: 40 }]);
    await putCached('user-a', `daily-audit:${projectId}:${getUtcPlus3DayStart()}`, [{ id: 1, entity_type: 'task_item',
      entity_id: itemId, action: 'updated', created_at: new Date().toISOString(), old_data: { percentage: 0 }, new_data: { percentage: 40 } }]);
    vi.stubGlobal('navigator', { onLine: false });
    f.from.mockImplementation(() => { throw new Error('Bulk SDK query must not start offline'); });
    f.session.mockImplementation(() => new Promise(() => undefined));
    const result = await listProjectDailyProgress(projectId);
    expect(result.entries).toEqual([expect.objectContaining({ title: 'Cached item', oldPercentage: 0, newPercentage: 40 })]);
    expect(f.from).not.toHaveBeenCalled(); expect(f.session).not.toHaveBeenCalled();
  });
  it('restoration already waiting on SDK refresh releases UI at the first transport failure', async () => {
    f.session.mockImplementation(() => new Promise(() => undefined));
    const restore = getReadSession();
    reportConnectivityFailure(new TypeError('Failed to fetch'));
    expect((await restore).data.session?.user.id).toBe('user-a');
  });
  it.each([{ status: 403, message: 'Failed to fetch' }, { code: 'P0001', message: 'timeout business rule' }, { status: 503, code: 'P0001', message: 'timeout business rule' }, { message: 'invalid JWT' }])('does not degrade for access/business errors: %j', (error) => {
    expect(isTransportFailure(error)).toBe(false); reportConnectivityFailure(error); expect(getConnectivityState()).toBe('online');
  });
  it.each(['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN'])('recognizes %s as a transport failure', (code) => {
    expect(isTransportFailure({ code })).toBe(true); reportConnectivityFailure({ code }); expect(getConnectivityState()).toBe('degraded');
  });
  it('central fetch suppresses offline auxiliary calls and SDK retry loops', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')); vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('navigator', { onLine: false });
    await expect(connectivityFetch('https://server.test')).rejects.toMatchObject({ name: 'AbortError' }); expect(fetch).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', { onLine: true }); reportConnectivitySuccess();
    await expect(connectivityFetch('https://server.test')).rejects.toMatchObject({ name: 'AbortError' });
    expect(getConnectivityState()).toBe('degraded');
    await expect(connectivityFetch('https://server.test')).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce();
  });
  it('retains HTTP-only denial status from the actual PostgREST response shape', async () => {
    await expect(readThroughCache('projects:active', async () => {
      const response = await uiRead(Promise.resolve({ data: null, error: { message: 'JWS signature failure' }, status: 401 }));
      throw response.error;
    })).rejects.toMatchObject({ status: 401 });
    expect(getConnectivityState()).toBe('online');
    vi.stubGlobal('navigator', { onLine: false });
    await expect(readThroughCache('projects:active', vi.fn())).rejects.toThrow();
  });
  it('distinguishes gateway availability failures from SQL/business HTTP 503 responses', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'P0001', message: 'Business rule' }), { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    expect((await connectivityFetch('https://server.test')).status).toBe(503);
    expect(getConnectivityState()).toBe('online');
    fetch.mockResolvedValue(new Response('Gateway unavailable', { status: 503 }));
    await connectivityFetch('https://server.test'); expect(getConnectivityState()).toBe('degraded');
  });
  it('aborts a real SDK UI query at its deadline with the native AbortSignal polyfill', async () => {
    vi.stubGlobal('AbortController', NativeAbortController); vi.stubGlobal('DOMException', undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let started = false;
    const client = new PostgrestClient('https://server.test', { fetch: (_input, init) => new Promise((_resolve, reject) => {
      started = true;
      init?.signal?.addEventListener('abort', () => { const error = new Error('Aborted'); error.name = 'AbortError'; reject(error); });
    }) });
    const reading = readThroughCache('projects:active', async () => {
      const result = await uiRead(client.from('projects').select('id'));
      if (result.error) throw result.error;
      return result.data;
    });
    await vi.waitFor(() => expect(started).toBe(true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await reading).toEqual([{ id: 'project-a' }]); expect(getConnectivityState()).toBe('degraded');
    await expect(connectivityFetch('https://server.test')).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses a publishable key with a recovered user JWT and does not mistake healthy Auth for healthy Data API', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 200 })).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetch);
    const auth = { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'user-token' } }, error: null }) };
    const cleanup = monitorConnectivity(() => probeSupabase('https://server.test', 'sb_publishable_test', auth));
    try {
      reportConnectivityFailure(new TypeError('Failed to fetch')); await revalidateConnectivity();
      expect(getConnectivityState()).toBe('degraded');
      expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer user-token');
      const online = vi.fn(); await readThroughCache('projects:active', online); expect(online).not.toHaveBeenCalled();
      fetch.mockResolvedValue(new Response('{}', { status: 200 })); await revalidateConnectivity(); expect(getConnectivityState()).toBe('online');
    } finally { cleanup(); }
  });
  it('ends a stalled Auth recovery and closes the exception without opening UI network reads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
    const auth = { getSession: vi.fn(() => new Promise<never>(() => undefined)) };
    const cleanup = monitorConnectivity(() => probeSupabase('https://server.test', 'sb_publishable_test', auth));
    try {
      reportConnectivityFailure(new TypeError('Failed to fetch')); const recovering = revalidateConnectivity();
      await vi.waitFor(() => expect(auth.getSession).toHaveBeenCalled()); await vi.advanceTimersByTimeAsync(AUTH_REVALIDATION_TIMEOUT_MS); await recovering;
      expect(getConnectivityState()).toBe('degraded');
      await expect(connectivityFetch('https://server.test/auth/v1/user')).rejects.toMatchObject({ name: 'AbortError' });
    } finally { cleanup(); }
  });
  it('recovers an expired session through the real SDK refresh cooldown without blocking local reads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let available = false;
    const stored = new Map<string, string>([['test-session', JSON.stringify({ user: { id: 'user-a' },
      access_token: 'expired-token', refresh_token: 'saved-refresh-token', expires_at: 1, token_type: 'bearer' })]]);
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (!available) throw new TypeError('Failed to fetch');
      if (String(input).includes('/token?')) return new Response(JSON.stringify({ access_token: 'renewed-token',
        refresh_token: 'rotated-refresh-token', token_type: 'bearer', expires_in: 3600, user: { id: 'user-a' } }), { status: 200 });
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const auth = new GoTrueClient({ url: 'https://server.test/auth/v1', storageKey: 'test-session',
      autoRefreshToken: false, detectSessionInUrl: false, fetch: connectivityFetch,
      storage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); }, removeItem: (key) => { stored.delete(key); } } });
    await auth.initialize();
    const failedRefresh = auth.getSession();
    await vi.waitFor(() => expect(getConnectivityState()).toBe('degraded'));
    await vi.advanceTimersByTimeAsync(30_000); expect((await failedRefresh).error).not.toBeNull();
    available = true;
    const cleanup = monitorConnectivity(() => probeSupabase('https://server.test', 'publishable', auth));
    try {
      await revalidateConnectivity(); expect(getConnectivityState()).toBe('degraded');
      expect(await readThroughCache('projects:active', vi.fn())).toEqual([{ id: 'project-a' }]);
      await vi.advanceTimersByTimeAsync(65_000);
      expect(getConnectivityState()).toBe('online');
      expect((await auth.getSession()).data.session?.access_token).toBe('renewed-token');
      expect(JSON.parse(stored.get('test-session')!).refresh_token).toBe('rotated-refresh-token');
    } finally { cleanup(); }
  });
});
