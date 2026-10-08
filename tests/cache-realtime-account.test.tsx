import 'fake-indexeddb/auto';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
const projectId = '00000000-0000-4000-8000-000000000010';
const f = vi.hoisted(() => ({ user: '', channel: vi.fn(), remove: vi.fn(), changed: (_event: string, _session: unknown) => {} }));
vi.mock('expo-linking', () => ({ addEventListener: () => ({ remove: vi.fn() }), getInitialURL: async () => null }));
vi.mock('@/features/auth/auth-links', () => ({ parseAuthCallbackUrl: vi.fn(), stripAuthCallbackParams: vi.fn(), createAuthRedirectUrl: vi.fn() }));
vi.mock('@/lib/local-cache/driver', async () => import('@/lib/local-cache/driver.web'));
vi.mock('@/lib/supabase/client', () => ({ probeSupabaseConnectivity: vi.fn(), supabase: {
  channel: f.channel, removeChannel: f.remove, rpc: async () => ({ data: { id: f.user }, error: null }),
  auth: { getSession: async () => ({ data: { session: f.user ? { user: { id: f.user }, expires_at: Date.now() / 1000 + 3600 } : null }, error: null }),
    onAuthStateChange: (callback: typeof f.changed) => { f.changed = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; } },
} }));
import { AuthProvider } from '@/features/auth/AuthProvider';
import { closeAllRealtimeChannels, subscribeTable } from '@/lib/supabase/realtime';
import { clearReadFreshness, confirmReadFreshness, currentReadAccount, invalidateReadModels, readAccountEpoch, readInvalidation, setReadAccount, settleReadInvalidations } from '@/lib/local-cache/read-freshness';
import { localCacheDriver } from '@/lib/local-cache/driver';
let renderer: ReactTestRenderer | undefined;
const channels: { on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> }[] = [];
beforeEach(async () => {
  closeAllRealtimeChannels(); setReadAccount(null); clearReadFreshness(); vi.clearAllMocks(); channels.length = 0; f.user = a;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('navigator', { onLine: true }); vi.spyOn(console, 'error').mockImplementation(() => {});
  await localCacheDriver.remove(a, 'read:acl:epoch'); await localCacheDriver.remove(b, 'read:acl:epoch');
  f.channel.mockImplementation(() => { const entry = { on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() }; channels.push(entry); return entry; });
});
afterEach(async () => { if (renderer) await act(async () => { renderer!.unmount(); }); renderer = undefined; closeAllRealtimeChannels(); setReadAccount(null); clearReadFreshness(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount() {
  await act(async () => { renderer = create(createElement(AuthProvider, { children: null })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}
it.each([b, null])('AuthProvider closes A channels before publishing %s and rejects delayed A events', async (next) => {
  await mount(); const listener = vi.fn(); subscribeTable('project_members', { userId: a, onEvent: listener });
  const receive = channels[0].on.mock.calls[0][2];
  const removedOwners: (string | null)[] = []; f.remove.mockImplementation(async () => { removedOwners.push(currentReadAccount()); });
  await act(async () => {
    f.user = next ?? ''; f.changed(next ? 'SIGNED_IN' : 'SIGNED_OUT', next ? { user: { id: next } } : null);
    expect(currentReadAccount()).toBe(next); expect(removedOwners).toEqual([a]);
    receive({ payload: { table: 'project_members', operation: 'DELETE' } });
  });
  await settleReadInvalidations(b); expect(listener).not.toHaveBeenCalled();
  expect(readInvalidation(b, `project:${projectId}`)).toEqual({ version: 0, kind: null });
  expect(await localCacheDriver.listEntries(b, 'read:')).toEqual([]);
});
it('a channel epoch independently fences A -> B -> A, even before channel cleanup', async () => {
  setReadAccount(a); const listener = vi.fn(); subscribeTable('projects', { projectId, onEvent: listener });
  const receive = channels[0].on.mock.calls[0][2]; setReadAccount(b); setReadAccount(a);
  receive({ payload: { table: 'projects', operation: 'DELETE' } });
  expect(listener).not.toHaveBeenCalled(); expect(readInvalidation(a, `project:${projectId}`).kind).toBeNull();
});
it('same-account TOKEN_REFRESHED preserves freshness waves and the live channel', async () => {
  await mount(); const listener = vi.fn(); subscribeTable('projects', { projectId, onEvent: listener }); f.remove.mockClear();
  await invalidateReadModels(a, ['project:']); const before = readInvalidation(a, `project:${projectId}`);
  confirmReadFreshness(a, `project:${projectId}`, before.version); const epoch = readAccountEpoch();
  await act(async () => { f.changed('TOKEN_REFRESHED', { user: { id: a } }); await new Promise((resolve) => setTimeout(resolve, 25)); });
  expect(readAccountEpoch()).toBe(epoch); expect(readInvalidation(a, `project:${projectId}`)).toEqual({ version: before.version, kind: null });
  expect(f.remove).not.toHaveBeenCalled(); channels[0].on.mock.calls[0][2]({ payload: { table: 'projects', operation: 'UPDATE' } }); expect(listener).toHaveBeenCalledOnce();
});
