import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ rows: [{ project_id: 'p', role: 'owner' }], from: vi.fn(), invalidate: vi.fn(), reconcile: vi.fn(),
  event: (_event: { table: string }) => {}, status: (_status: string) => {}, connectivity: (_next: string) => {}, gate: null as Promise<void> | null }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { from: f.from } }));
vi.mock('@/lib/supabase/realtime', () => ({ subscribeToPermissionChanges: (_id: string, event: typeof f.event, status: typeof f.status) => {
  f.event = event; f.status = status; return () => {};
} }));
vi.mock('@/lib/connectivity/state', () => ({ usesLocalReads: () => false, subscribeConnectivity: (fn: typeof f.connectivity) => { f.connectivity = fn; return () => {}; } }));
vi.mock('@/lib/local-cache/cache', () => ({ activeCacheUserId: async () => 'user', reconcileVisibleProjects: f.reconcile,
  getCached: async (_id: string, key: string) => key === 'projects:active' ? [{ id: 'p', role: 'owner' }] : [],
}));
vi.mock('@/lib/local-cache/read-freshness', () => ({ invalidateReadModels: f.invalidate }));
import { PermissionProvider, usePermissionVersion } from '@/features/auth/PermissionProvider';
let version = 0; let screen: ReactTestRenderer;
function Consumer() { version = usePermissionVersion(); return null; }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  f.rows = [{ project_id: 'p', role: 'owner' }]; f.gate = null; f.invalidate.mockReset().mockResolvedValue(undefined); f.reconcile.mockReset(); f.from.mockReset();
  f.from.mockImplementation(() => { const q = { select: () => q, eq: () => q, order: () => q, range: async () => { await f.gate; return { data: [...f.rows], error: null }; } }; return q; });
});
afterEach(async () => { await act(async () => { screen?.unmount(); }); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount() {
  await act(async () => { screen = create(createElement(PermissionProvider, { userId: 'user', children: createElement(Consumer) })); });
  await act(async () => { await vi.runAllTimersAsync(); });
}
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
  expect(version).toBe(1); expect(f.invalidate).toHaveBeenCalledWith('user', undefined, 'access'); expect(f.reconcile).toHaveBeenCalledOnce();
});
it('task override ACL signals invalidate immediately without a membership or assignment query', async () => {
  await mount(); f.from.mockClear(); await act(async () => { f.event({ table: 'task_members' }); });
  expect(version).toBe(1); expect(f.invalidate).not.toHaveBeenCalled(); expect(f.from).not.toHaveBeenCalled();
});
it('ordinary reconnect forces server reads without quarantining inactive offline models', async () => {
  await mount(); await act(async () => { f.connectivity('online'); });
  expect(version).toBe(1); expect(f.invalidate).toHaveBeenCalledWith('user', undefined, 'refresh');
  expect(f.invalidate).not.toHaveBeenCalledWith('user', undefined, 'access');
});
