import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ rpc: vi.fn(), epoch: 1 }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { rpc: f.rpc } }));
vi.mock('@/lib/local-cache/cache', () => ({ activeCacheUserId: async () => 'account-a',
  isTransportFailure: (e: Error) => /fetch|timeout/i.test(e?.message ?? '') || e?.name === 'TimeoutError' }));
vi.mock('@/lib/local-cache/read-freshness', () => ({ readAccountEpoch: () => f.epoch }));
vi.mock('@/lib/connectivity/state', () => ({ usesLocalReads: () => false }));
vi.mock('@/lib/local-cache/driver', async () => await import('@/lib/local-cache/driver.web'));
function tabStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }, values };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function serialLocks() {
  let tail = Promise.resolve(); let held: string | null = null;
  const request = vi.fn((_key: string, options: { signal: AbortSignal }, work: () => unknown) => {
    const next = tail.then(async () => { if (options.signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' }); held=_key; try { return await work(); } finally { held=null; } });
    tail = next.then(() => undefined, () => undefined); return next;
  });
  vi.stubGlobal('navigator', { locks: { request, query: async () => ({held:held?[{name:held}]:[],pending:[]}) } }); return request;
}
beforeEach(async () => {
  vi.useRealTimers(); vi.resetModules(); f.rpc.mockReset(); f.epoch = 1;
  await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase('tasktrace-local-cache'); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function server() {
  const receipts = new Map<string, string>(); let effects = 0;
  return { receipts, effects: () => effects, run: (args: { p_operation_id: string }) => {
    if (!receipts.has(args.p_operation_id)) receipts.set(args.p_operation_id, `created-${++effects}`);
    return { data: receipts.get(args.p_operation_id), error: null, status: 200 };
  } };
}
async function clean() {
  const { localCacheDriver } = await import('@/lib/local-cache/driver');
  expect(await localCacheDriver.listEntries('account-a', 'sync:mutation:')).toEqual([]);
  expect(await localCacheDriver.listPending('account-a')).toEqual([]);
}
it('REG-01: independent contexts retry the same committed lost ACK with one effect and retire their handles', async () => {
  const locks = serialLocks(), a = tabStorage(), b = tabStorage(), backend = server(), hold = deferred(); let lost = true;
  f.rpc.mockImplementation(async (_name, args) => { const result = backend.run(args); if (lost) { lost = false; throw new TypeError('Failed to fetch'); } await hold.promise; return result; });
  vi.stubGlobal('sessionStorage', a);
  const tabA = await import('@/lib/supabase/mutation');
  await expect(tabA.executeMutation('create_project', { p_name: 'same' })).rejects.toThrow();
  const retryA = tabA.executeMutation('create_project', { p_name: 'same' });
  await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledTimes(2));
  vi.resetModules(); vi.stubGlobal('sessionStorage', b);
  const tabB = await import('@/lib/supabase/mutation');
  const retryB = tabB.executeMutation('create_project', { p_name: 'same' });
  await vi.waitFor(() => expect(locks).toHaveBeenCalledTimes(3));
  hold.resolve(); const results = await Promise.all([retryA, retryB]);
  expect(backend.effects()).toBe(1); expect(new Set(f.rpc.mock.calls.map(call => call[1].p_operation_id)).size).toBe(1);
  expect(results[0].data).toBe(results[1].data); expect(a.values.size).toBe(0); expect(b.values.size).toBe(0); await clean();
});
it('a queued retry survives deadline and reload after another tab has removed the shared envelope', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const a = tabStorage(), b = tabStorage(), backend = server(), ack = deferred(); let requests = 0, lost = true;
  vi.stubGlobal('navigator', { locks: { request: (_key: string, options: { signal: AbortSignal }, work: () => unknown) => {
    requests++;
    if (requests !== 3) return work();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true }));
  } } });
  f.rpc.mockImplementation(async (_name, args) => { const result = backend.run(args); if (lost) { lost = false; throw new TypeError('Failed to fetch'); } await ack.promise; return result; });
  vi.stubGlobal('sessionStorage', a); const tabA = await import('@/lib/supabase/mutation');
  await expect(tabA.executeMutation('create_project', { p_name: 'same' })).rejects.toThrow();
  const retryA = tabA.executeMutation('create_project', { p_name: 'same' });
  await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledTimes(2));
  vi.resetModules(); vi.stubGlobal('sessionStorage', b); const tabB = await import('@/lib/supabase/mutation');
  const timeout = expect(tabB.executeMutation('create_project', { p_name: 'same' })).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.waitFor(() => expect(requests).toBe(3)); ack.resolve(); await retryA; await clean();
  await vi.advanceTimersByTimeAsync(45_001); await timeout;
  expect(b.values.size).toBe(1); vi.resetModules();
  await expect((await import('@/lib/supabase/mutation')).executeMutation('create_project', { p_name: 'same' })).resolves.toMatchObject({ data: 'created-1' });
  expect(backend.effects()).toBe(1); expect(new Set(f.rpc.mock.calls.map(call => call[1].p_operation_id)).size).toBe(1);
  expect(b.values.size).toBe(0); await clean();
});
it('closing the failed tab leaves its unresolved shared envelope available to another context', async () => {
  serialLocks(); const backend = server(); let lost = true;
  f.rpc.mockImplementation(async (_name, args) => { const result = backend.run(args); if (lost) { lost = false; throw new TypeError('Failed to fetch'); } return result; });
  vi.stubGlobal('sessionStorage', tabStorage());
  await expect((await import('@/lib/supabase/mutation')).executeMutation('create_project', { p_name: 'same' })).rejects.toThrow();
  vi.resetModules(); vi.stubGlobal('sessionStorage', tabStorage());
  await expect((await import('@/lib/supabase/mutation')).executeMutation('create_project', { p_name: 'same' })).resolves.toMatchObject({ data: 'created-1' });
  expect(backend.effects()).toBe(1); await clean();
});
it.each([false, true])('independent identical actions keep different IDs (separate contexts: %s)', async (separate) => {
  serialLocks(); vi.stubGlobal('sessionStorage', tabStorage()); const backend = server(), ack = deferred(); let calls = 0;
  f.rpc.mockImplementation(async (_name, args) => { const result = backend.run(args); if (++calls === 1) await ack.promise; return result; });
  const tabA = await import('@/lib/supabase/mutation'); const first = tabA.executeMutation('create_project', { p_name: 'same' });
  await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledOnce());
  if (separate) { vi.resetModules(); vi.stubGlobal('sessionStorage', tabStorage()); }
  const second = (await import('@/lib/supabase/mutation')).executeMutation('create_project', { p_name: 'same' });
  // Ensure the second invocation observes the first still in flight.
  await vi.waitFor(async () => expect((await import('@/lib/local-cache/driver')).localCacheDriver).toBeDefined());
  await new Promise(resolve => setTimeout(resolve, 20)); ack.resolve();
  const results = await Promise.all([first, second]); expect(backend.effects()).toBe(2); expect(results.map(r => r.data)).toEqual(['created-1', 'created-2']);
  expect(new Set(f.rpc.mock.calls.map(call => call[1].p_operation_id)).size).toBe(2); await clean();
});
it('a cancelled queued fresh action cannot start later when Web Locks are unavailable', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.stubGlobal('navigator', {}); vi.stubGlobal('sessionStorage', tabStorage());
  const hold = deferred(); f.rpc.mockImplementation(async () => { await hold.promise; return { data: 'ok', error: null, status: 200 }; });
  const { executeMutation } = await import('@/lib/supabase/mutation');
  const first = expect(executeMutation('create_project', { p_name: 'one' })).rejects.toThrow();
  await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledOnce());
  const second = expect(executeMutation('create_project', { p_name: 'two' })).rejects.toThrow();
  f.epoch++; await vi.advanceTimersByTimeAsync(45_001); await Promise.all([first, second]);
  hold.resolve(); await vi.advanceTimersByTimeAsync(0); expect(f.rpc).toHaveBeenCalledOnce();
});
