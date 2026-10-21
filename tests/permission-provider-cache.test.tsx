import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ rows: [{ project_id: 'p', role: 'owner' }], from: vi.fn(), invalidate: vi.fn(), reconcile: vi.fn(),
  event: (_event: { table: string }) => {}, status: (_status: string) => {}, connectivity: (_next: string) => {}, gate: null as Promise<void> | null,
  identity: vi.fn(), cacheGate: null as Promise<void> | null, epoch: 0 }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { from: f.from } }));
vi.mock('@/lib/supabase/realtime', () => ({ subscribeToPermissionChanges: (_id: string, event: typeof f.event, status: typeof f.status) => {
  f.event = event; f.status = status; return () => {};
} }));
vi.mock('@/lib/connectivity/state', () => ({ usesLocalReads: () => false, subscribeConnectivity: (fn: typeof f.connectivity) => { f.connectivity = fn; return () => {}; } }));
vi.mock('@/lib/local-cache/cache', () => ({ activeCacheUserId: f.identity, reconcileVisibleProjects: f.reconcile,
  getCached: async (_id: string, key: string) => { await f.cacheGate; return key === 'projects:active' ? [{ id: 'p', role: 'owner' }] : []; },
}));
vi.mock('@/lib/local-cache/read-freshness', () => ({ invalidateReadModels: f.invalidate, readAccountEpoch: () => f.epoch }));
import { PermissionProvider, usePermissionVersion } from '@/features/auth/PermissionProvider';
let version = 0; let screen: ReactTestRenderer;
function Consumer() { version = usePermissionVersion(); return null; }
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  f.rows = [{ project_id: 'p', role: 'owner' }]; f.gate = null; f.cacheGate = null; f.epoch = 0; f.identity.mockReset().mockResolvedValue('user'); f.invalidate.mockReset().mockResolvedValue(undefined); f.reconcile.mockReset(); f.from.mockReset();
  f.from.mockImplementation(() => { const q = { select: () => q, eq: () => q, order: () => q, range: async () => { await f.gate; return { data: [...f.rows], error: null }; } }; return q; });
});
afterEach(async () => { await act(async () => { screen?.unmount(); }); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount() {
  await act(async () => { screen = create(createElement(PermissionProvider, { userId: 'user', children: createElement(Consumer) })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}
it.each(['query', 'identity', 'cached storage'])('REG-02: an expired %s stage has no late ACL effects and allows a fresh check', async (stage) => {
  await mount(); await act(async () => { f.status('connected'); });
  f.rows = []; const hold = deferred(); const identity = deferred<string>();
  if (stage === 'query') f.gate = hold.promise;
  if (stage === 'cached storage') f.cacheGate = hold.promise;
  if (stage === 'identity') f.identity.mockImplementationOnce(() => identity.promise);
  await act(async () => { f.event({ table: 'project_members' }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
  expect(f.invalidate).not.toHaveBeenCalled(); expect(f.reconcile).not.toHaveBeenCalled();
  f.gate = null; f.cacheGate = null;
  await act(async () => { hold.resolve(); identity.resolve('user'); });
  expect(f.invalidate).not.toHaveBeenCalled(); expect(f.reconcile).not.toHaveBeenCalled();
  await act(async () => { f.event({ table: 'project_members' }); });
  expect(f.invalidate).toHaveBeenCalledOnce(); expect(f.reconcile).toHaveBeenCalledOnce();
});
it('a storage write that expires cannot start reconciliation; the next check retries the membership change', async () => {
  await mount(); const hold = deferred(); f.rows = []; f.invalidate.mockImplementationOnce(() => hold.promise);
  await act(async () => { f.event({ table: 'project_members' }); });
  expect(f.invalidate).toHaveBeenCalledOnce();
  const signal = f.invalidate.mock.calls[0][3] as AbortSignal;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_001); }); expect(signal.aborted).toBe(true);
  await act(async () => { hold.resolve(); }); expect(f.reconcile).not.toHaveBeenCalled();
  await act(async () => { f.event({ table: 'project_members' }); });
  expect(f.invalidate).toHaveBeenCalledTimes(2); expect(f.reconcile).toHaveBeenCalledOnce();
});
it.each(['account epoch', 'logout', 'unmount'])('late identity completion after %s cannot change ACL', async (change) => {
  await mount(); const hold = deferred<string>(); f.rows = []; f.identity.mockImplementationOnce(() => hold.promise);
  await act(async () => { f.event({ table: 'project_members' }); });
  await act(async () => {
    if (change === 'account epoch') f.epoch++;
    if (change === 'logout') screen.update(createElement(PermissionProvider, { userId: null, children: null }));
    if (change === 'unmount') screen.unmount();
  });
  await act(async () => { hold.resolve('user'); });
  expect(f.invalidate).not.toHaveBeenCalled(); expect(f.reconcile).not.toHaveBeenCalled();
});
it('reconnect supersedes a hanging identity stage and its late result cannot overwrite the new check', async () => {
  await mount(); const hold = deferred<string>(); f.rows = []; f.identity.mockImplementationOnce(() => hold.promise);
  await act(async () => { f.event({ table: 'project_members' }); });
  await act(async () => { f.connectivity('online'); });
  expect(f.reconcile).toHaveBeenCalledOnce(); const count = f.invalidate.mock.calls.length;
  await act(async () => { hold.resolve('user'); });
  expect(f.reconcile).toHaveBeenCalledOnce(); expect(f.invalidate).toHaveBeenCalledTimes(count);
});
it('callbacks already queued before unmount cannot invalidate storage', async () => {
  await mount(); await act(async () => { screen.unmount(); });
  await act(async () => { f.connectivity('online'); f.event({ table: 'project_members' }); });
  expect(f.invalidate).not.toHaveBeenCalled(); expect(f.reconcile).not.toHaveBeenCalled();
});
it('unchanged memberships never bump permission version or fetch assignments', async () => {
  await mount(); await act(async () => { f.status('connected'); });
  expect(version).toBe(0); expect(f.invalidate).not.toHaveBeenCalled();
  expect(f.from.mock.calls.every(([table]) => table === 'project_members')).toBe(true);
});
it('a subscription established during the initial query schedules a second authoritative check', async () => {
  let release!: () => void; f.gate = new Promise((resolve) => { release = resolve; });
  await mount(); expect(f.from).toHaveBeenCalledOnce();
  await act(async () => { f.status('connected'); }); expect(f.from).toHaveBeenCalledOnce();
  f.gate = null; await act(async () => { release(); }); expect(f.from).toHaveBeenCalledTimes(2); expect(version).toBe(0);
});
it.each(['viewer', 'revoked'])('reconnect detects a missed membership change: %s', async (change) => {
  await mount(); await act(async () => { f.status('connected'); });
  f.rows = change === 'revoked' ? [] : [{ project_id: 'p', role: change }];
  await act(async () => { f.status('reconnecting'); f.status('connected'); });
  expect(version).toBe(1); expect(f.invalidate).toHaveBeenCalledWith('user', undefined, 'access', expect.any(AbortSignal)); expect(f.reconcile).toHaveBeenCalledOnce();
});
it('task override ACL signals invalidate immediately without a membership or assignment query', async () => {
  await mount(); f.from.mockClear(); await act(async () => { f.event({ table: 'task_members' }); });
  expect(version).toBe(1); expect(f.invalidate).not.toHaveBeenCalled(); expect(f.from).not.toHaveBeenCalled();
});
it('ordinary reconnect forces server reads without quarantining inactive offline models', async () => {
  await mount(); await act(async () => { f.connectivity('online'); });
  expect(version).toBe(1); expect(f.invalidate).toHaveBeenCalledWith('user', undefined, 'refresh', expect.any(AbortSignal));
  expect(f.invalidate).not.toHaveBeenCalledWith('user', undefined, 'access');
});
it('BUG-07 reconnect supersedes an indefinitely stalled check and ignores its late result', async () => {
  await mount(); let release!: () => void;
  f.gate = new Promise((resolve) => { release = resolve; });
  await act(async () => { f.status('connected'); });
  const stalledCalls = f.from.mock.calls.length;
  f.gate = null; f.rows = [];
  await act(async () => { f.connectivity('online'); });
  expect(f.from.mock.calls.length).toBeGreaterThan(stalledCalls); expect(f.reconcile).toHaveBeenCalledOnce();
  const after = version;
  f.rows = [{ project_id: 'p', role: 'owner' }]; await act(async () => release());
  expect(version).toBe(after); expect(f.reconcile).toHaveBeenCalledOnce();
});
it('BUG-07 a timed-out check releases pending so a later subscription can check again', async () => {
  f.gate = new Promise(() => {}); await mount(); const before = f.from.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); }); f.gate = null; f.rows = [];
  await act(async () => { f.status('connected'); });
  expect(f.from.mock.calls.length).toBeGreaterThan(before); expect(f.reconcile).toHaveBeenCalledOnce();
});
