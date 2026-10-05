import { beforeEach, expect, it, vi } from 'vitest';
import type { CacheEntry } from '@/lib/local-cache/types';
const f = vi.hoisted(() => ({ user: 'user-a', writesFail: false, entries: new Map<string, CacheEntry>(), readGate: null as null | { key: string; wait: Promise<void> } }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { user: { id: f.user } } }, error: null }) } } }));
vi.mock('@/lib/local-cache/driver', () => ({ localCacheDriver: {
  get: async (user: string, key: string) => { const saved = f.entries.get(`${user}:${key}`) ?? null;
    if (f.readGate?.key === key) { const gate = f.readGate; f.readGate = null; await gate.wait; } return saved; },
  put: async (entry: CacheEntry) => { if (f.writesFail) throw new Error('IndexedDB failed'); f.entries.set(`${entry.user_id}:${entry.key}`, entry); },
  putIfUnchanged: async (entry: CacheEntry, baseline: string | null) => { if (f.writesFail) throw new Error('IndexedDB failed');
    const key = `${entry.user_id}:${entry.key}`; if ((f.entries.get(key)?.data ?? null) === baseline) f.entries.set(key, entry); },
  remove: async (user: string, key: string) => { if (f.writesFail) throw new Error('IndexedDB failed'); f.entries.delete(`${user}:${key}`); },
} }));
beforeEach(() => { vi.resetModules(); f.entries.clear(); f.user = 'user-a'; f.writesFail = false; f.readGate = null; vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
const denied = { status: 403, code: '42501', message: 'permission denied' };
const offline = () => import('@/lib/connectivity/state').then((s) => s.reportConnectivityFailure(new TypeError('Failed to fetch')));
it('AUD-13: a revoke during a pending local read is checked again before returning data', async () => {
  const c = await import('@/lib/local-cache/cache');
  const options = { projectId: 'project', clearProjectBlockOnSuccess: true };
  await c.readThroughCache('project:project', async () => ({ id: 'project' }), options);
  await offline(); let release!: () => void;
  f.readGate = { key: 'project:project', wait: new Promise<void>((resolve) => { release = resolve; }) };
  const reading = c.readThroughCache('project:project', async () => { throw new Error('offline'); }, options);
  await vi.waitFor(() => expect(f.readGate).toBeNull());
  (await import('@/lib/connectivity/state')).reportConnectivitySuccess(); f.writesFail = true;
  await expect(c.readThroughCache('project:project', async () => { throw denied; }, options)).rejects.toBe(denied);
  release(); await expect(reading).rejects.toThrow();
});
it('AUD-13: confirmed 403 denies cached reads immediately even if all IndexedDB writes fail', async () => {
  const c = await import('@/lib/local-cache/cache');
  const options = { projectId: 'project', clearProjectBlockOnSuccess: true };
  await c.readThroughCache('project:project', async () => ({ id: 'project' }), options);
  f.writesFail = true;
  await expect(c.readThroughCache('project:project', async () => { throw denied; }, options)).rejects.toBe(denied);
  await offline();
  await expect(c.readThroughCache('project:project', async () => ({ id: 'project' }), options)).rejects.toThrow();
  expect(await c.filterBlockedProjects('user-a', [{ id: 'project' }])).toEqual([]);
  f.user = 'user-b'; expect(await c.filterBlockedProjects('user-b', [{ id: 'project' }])).toEqual([{ id: 'project' }]);
});
it('AUD-13: a late old success cannot clear a newer revoke; a fresh authorized request can', async () => {
  const c = await import('@/lib/local-cache/cache');
  const options = { taskId: 'task', clearTaskBlockOnSuccess: true };
  await c.readThroughCache('task:task', async () => ({ id: 'task' }), options);
  let finish!: () => void;
  const old = c.readThroughCache('task:task', () => new Promise<{ id: string }>((resolve) => { finish = () => resolve({ id: 'task' }); }), options);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  f.writesFail = true;
  await expect(c.readThroughCache('task:task', async () => { throw denied; }, options)).rejects.toBe(denied);
  finish(); await expect(old).rejects.toThrow();
  await offline(); expect(await c.getCached('user-a', 'blocked-task:task')).toBe(true);
  const s = await import('@/lib/connectivity/state'); s.reportConnectivitySuccess();
  await c.readThroughCache('task:task', async () => ({ id: 'task' }), options);
  await offline(); expect(await c.readThroughCache('task:task', async () => { throw new Error('should not call'); }, options)).toEqual({ id: 'task' });
});
