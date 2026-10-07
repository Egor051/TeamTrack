import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ user: 'a', expired: false, invalid: false }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { auth: { getSession: async () => ({
  data: { session: f.user ? { user: { id: f.user }, expires_at: f.expired ? 1 : Date.now() / 1000 + 3600 } : null },
  error: f.invalid ? { status: 401 } : null,
}) } } }));
vi.mock('@/lib/local-cache/driver', async () => await import('@/lib/local-cache/driver.web'));
beforeEach(async () => {
  vi.resetModules(); f.user = 'a'; f.expired = false; f.invalid = false;
  await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase('tasktrace-local-cache'); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
  (await import('@/lib/local-cache/read-freshness')).setReadAccount('a');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function save(key = 'project:p', value: unknown = { id: 'p', name: 'saved' }, age = 0, user = 'a') {
  const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
  await driver.put({ user_id: user, key, data: JSON.stringify(value), last_synced_at: new Date(Date.now() - age).toISOString(), schema_version: 1 });
  return driver;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
it('fresh online cache returns immediately and repeated readers make no HTTP request', async () => {
  await save(); const c = await import('@/lib/local-cache/cache'); const fetch = vi.fn(() => new Promise<never>(() => {}));
  for (let i = 0; i < 10; i++) {
    const row = await c.readCachedModel('project:p', fetch);
    expect(row).toEqual({ id: 'p', name: 'saved' }); expect(c.isLocalResult(row)).toBe(true); expect(c.isCachedResult(row)).toBe(false);
  }
  expect(fetch).not.toHaveBeenCalled();
});
it('stale cache is available before HTTP and ten simultaneous readers share one refresh', async () => {
  const driver = await save('project:p', { name: 'old' }, 65_000); const c = await import('@/lib/local-cache/cache');
  const gate = deferred<{ name: string }>(); const fetch = vi.fn(() => gate.promise);
  expect(await Promise.all(Array.from({ length: 10 }, () => c.readCachedModel('project:p', fetch)))).toEqual(Array(10).fill({ name: 'old' }));
  expect(fetch).toHaveBeenCalledOnce(); gate.resolve({ name: 'new' });
  await vi.waitFor(async () => expect(JSON.parse((await driver.get('a', 'project:p'))!.data)).toEqual({ name: 'new' }));
});
it('manual refresh awaits the server and joins simultaneous checks', async () => {
  await save(); const c = await import('@/lib/local-cache/cache'); const gate = deferred<{ name: string }>(); const fetch = vi.fn(() => gate.promise);
  const read = Promise.all(Array.from({ length: 5 }, () => c.readCachedModel('project:p', fetch, { forceRefresh: true })));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); gate.resolve({ name: 'server' });
  expect(await read).toEqual(Array(5).fill({ name: 'server' }));
});
it('data invalidation targets one task and keeps unrelated models fresh', async () => {
  await save('items:t:active', []); await save('items:other:active', []); const r = await import('@/lib/local-cache/read-freshness');
  await r.invalidateRealtimeModels('a', 'task_items', { taskId: 't' }); const c = await import('@/lib/local-cache/cache');
  const changed = vi.fn(async () => []); const unrelated = vi.fn(async () => []);
  await c.readCachedModel('items:t:active', changed); await c.readCachedModel('items:other:active', unrelated);
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce()); expect(unrelated).not.toHaveBeenCalled();
});
it('ACL signals quarantine immediately and cannot use transport fallback', async () => {
  const driver = await save(); const r = await import('@/lib/local-cache/read-freshness'); const c = await import('@/lib/local-cache/cache');
  const persisting = r.invalidateReadModels('a', ['project:p'], 'access');
  expect(await c.getCached('a', 'project:p')).toBeNull(); await persisting;
  await expect(c.readCachedModel('project:p', async () => { throw new TypeError('Failed to fetch'); }, { projectId: 'p' })).rejects.toThrow();
  expect(await driver.get('a', 'project:p')).not.toBeNull();
  (await import('@/lib/connectivity/state')).reportConnectivitySuccess();
  expect(await c.readCachedModel('project:p', async () => ({ id: 'p', name: 'allowed' }), { projectId: 'p', clearProjectBlockOnSuccess: true })).toMatchObject({ name: 'allowed' });
  expect(r.readInvalidation('a', 'project:p').kind).toBeNull();
});
it('an old request cannot poison a newer successful ACL check or its cache', async () => {
  const driver = await save(); const c = await import('@/lib/local-cache/cache'); const r = await import('@/lib/local-cache/read-freshness');
  const gate = deferred<{ id: string; name: string }>(); const fetch = vi.fn(() => gate.promise); const old = c.readCachedModel('project:p', fetch, { projectId: 'p', forceRefresh: true });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  await r.invalidateReadModels('a', ['project:p'], 'access');
  await c.readCachedModel('project:p', async () => ({ id: 'p', name: 'new' }), { projectId: 'p', clearProjectBlockOnSuccess: true });
  gate.resolve({ id: 'p', name: 'old' }); expect(await old).toMatchObject({ name: 'new' });
  expect(await c.getCached('a', 'blocked:p')).toBe(false); expect(await c.getCached('a', 'project:p')).toMatchObject({ name: 'new' });
});
it('ACL quarantine survives a reload and is isolated by account', async () => {
  await save(); await save('project:p', { id: 'p', name: 'b' }, 0, 'b');
  await (await import('@/lib/local-cache/read-freshness')).invalidateReadModels('a', ['project:p'], 'access');
  vi.resetModules(); const c = await import('@/lib/local-cache/cache');
  expect(await c.getCached('a', 'project:p')).toBeNull(); expect(await c.getCached('b', 'project:p')).toMatchObject({ name: 'b' });
});
it('a reconnect server-check marker preserves confirmed inactive cache on the next offline cycle', async () => {
  await save(); const c = await import('@/lib/local-cache/cache'); const r = await import('@/lib/local-cache/read-freshness');
  await r.invalidateReadModels('a', ['project:p'], 'refresh');
  (await import('@/lib/connectivity/state')).reportConnectivityFailure(new TypeError('Failed to fetch'));
  const fetch = vi.fn(async () => ({ id: 'p' })); expect(await c.readCachedModel('project:p', fetch)).toMatchObject({ name: 'saved' });
  expect(fetch).not.toHaveBeenCalled();
});
it('an ACL event during the IndexedDB read fences the already loaded value', async () => {
  const driver = await save(); const r = await import('@/lib/local-cache/read-freshness'); const c = await import('@/lib/local-cache/cache');
  const gate = deferred<void>(); const original = driver.get.bind(driver); let entered = false;
  vi.spyOn(driver, 'get').mockImplementation(async (u, key) => { const value = await original(u, key); if (key === 'project:p' && !entered) { entered = true; await gate.promise; } return value; });
  const reading = c.getCached('a', 'project:p'); await vi.waitFor(() => expect(entered).toBe(true));
  await r.invalidateReadModels('a', ['project:p'], 'access'); gate.resolve(); expect(await reading).toBeNull();
});
it('reconnect RLS checks wait for their own pending ACL marker and recover without Retry', async () => {
  const driver = await save(); const c = await import('@/lib/local-cache/cache'); const r = await import('@/lib/local-cache/read-freshness');
  const gate = deferred<void>(); const original = driver.listEntries.bind(driver); let entered = false;
  vi.spyOn(driver, 'listEntries').mockImplementation(async (...args) => { entered = true; await gate.promise; return original(...args); });
  const invalidating = r.invalidateReadModels('a', ['project:p'], 'access'); await vi.waitFor(() => expect(entered).toBe(true));
  const fetch = vi.fn(async () => ({ id: 'p', name: 'server after reconnect' }));
  const reading = c.readCachedModel('project:p', fetch, { projectId: 'p', clearProjectBlockOnSuccess: true });
  await new Promise((resolve) => setTimeout(resolve, 0)); expect(fetch).not.toHaveBeenCalled();
  gate.resolve(); await invalidating; expect(await reading).toMatchObject({ name: 'server after reconnect' });
  expect(await c.getCached('a', 'project:p')).toMatchObject({ name: 'server after reconnect' });
});
it('an ACL event during the final freshness lookup cannot expose the already parsed online cache', async () => {
  const driver = await save(); const c = await import('@/lib/local-cache/cache'); const r = await import('@/lib/local-cache/read-freshness');
  const gate = deferred<void>(); const original = driver.get.bind(driver); let reads = 0; let entered = false;
  vi.spyOn(driver, 'get').mockImplementation(async (u, key) => {
    const row = await original(u, key);
    if (key === 'project:p' && ++reads === 3) { entered = true; await gate.promise; }
    return row;
  });
  const fetch = vi.fn(async () => ({ id: 'p' })); const reading = c.readCachedModel('project:p', fetch); const rejected = expect(reading).rejects.toThrow();
  await vi.waitFor(() => expect(entered).toBe(true)); await r.invalidateReadModels('a', ['project:p'], 'access');
  gate.resolve(); await rejected; expect(fetch).not.toHaveBeenCalled();
});
it('A to B to A and logout cannot revive a request from the previous account epoch', async () => {
  const driver = await save(); const c = await import('@/lib/local-cache/cache'); const r = await import('@/lib/local-cache/read-freshness');
  const gate = deferred<{ name: string }>(); const fetch = vi.fn(() => gate.promise);
  const old = c.readCachedModel('project:p', fetch, { forceRefresh: true }); const rejected = expect(old).rejects.toThrow();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); f.user = 'b'; r.setReadAccount('b'); f.user = 'a'; r.setReadAccount('a');
  gate.resolve({ name: 'old account response' }); await rejected;
  expect(JSON.parse((await driver.get('a', 'project:p'))!.data)).toMatchObject({ name: 'saved' });
  f.user = ''; r.setReadAccount(null); await expect(c.readCachedModel('project:p', async () => { throw new TypeError('Failed to fetch'); })).rejects.toThrow();
});
it.each(['account', 'ACL'])('a late negative response from an old %s epoch cannot revoke a newer grant', async (kind) => {
  await save(); const c = await import('@/lib/local-cache/cache'); const r = await import('@/lib/local-cache/read-freshness');
  const gate = deferred<void>(); const fetch = vi.fn(async () => { await gate.promise; throw { status: 403, code: '42501', message: 'Old denial' }; });
  const old = c.readCachedModel('project:p', fetch, { projectId: 'p', forceRefresh: true }); const rejected = expect(old).rejects.toThrow();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  if (kind === 'account') { r.setReadAccount('b'); r.setReadAccount('a'); }
  else await r.invalidateReadModels('a', ['project:p'], 'access');
  await c.readCachedModel('project:p', async () => ({ id: 'p', name: 'new grant' }), { projectId: 'p', clearProjectBlockOnSuccess: true, forceRefresh: true });
  gate.resolve(); await rejected;
  expect(await c.getCached('a', 'blocked:p')).toBe(false); expect(await c.getCached('a', 'project:p')).toMatchObject({ name: 'new grant' });
});
it.each(['expired', 'invalid'])('%s sessions cannot display a valid saved model', async (kind) => {
  await save(); f.expired = kind === 'expired'; f.invalid = kind === 'invalid'; const c = await import('@/lib/local-cache/cache');
  await expect(c.readCachedModel('project:p', async () => { throw { status: 401, message: 'Invalid JWT' }; })).rejects.toMatchObject({ status: 401 });
});
it('business errors remain server errors on subsequent reads; repeated denials notify once', async () => {
  await save(); const c = await import('@/lib/local-cache/cache'); const e = await import('@/lib/local-cache/read-model-events');
  const changed = vi.fn(); const off = e.subscribeReadModelCommits(changed); const error = { code: 'P0001', message: 'business rejection' };
  await expect(c.readCachedModel('project:p', async () => { throw error; }, { forceRefresh: true })).rejects.toBe(error);
  const next = vi.fn(async () => { throw error; }); await expect(c.readCachedModel('project:p', next)).rejects.toBe(error); expect(next).toHaveBeenCalledOnce();
  changed.mockClear(); const denied = { status: 403, code: '42501', message: 'Denied' };
  await expect(c.readCachedModel('task:t', async () => { throw denied; }, { taskId: 't' })).rejects.toBe(denied);
  await expect(c.readCachedModel('task:t', async () => { throw denied; }, { taskId: 't' })).rejects.toBe(denied);
  expect(changed).toHaveBeenCalledOnce(); off();
});
it('the all-items projection uses disjoint partitions and retains a newer pull after CAS loss', async () => {
  const rows = [{ id: 'active', position: 1, is_archived: false, sync_version: 1 }, { id: 'archived', position: 2, is_archived: true, sync_version: 1 }];
  const c = await import('@/lib/local-cache/cache'); const driver = await save('items:t:active', [rows[0]]); await save('items:t:archived', [rows[1]]);
  expect(await c.readCachedModel('items:t:all', async () => rows)).toEqual(rows); expect(await driver.get('a', 'items:t:all')).toBeNull();
  const gate = deferred<typeof rows>(); const fetch = vi.fn(() => gate.promise); const request = c.readCachedModel('items:t:all', fetch, { forceRefresh: true });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); const newer = { ...rows[0], sync_version: 2 };
  await save('items:t:active', [newer]); gate.resolve(rows); expect(await request).toEqual([newer, rows[1]]);
  expect(await driver.get('a', 'items:t:all')).toBeNull();
});
