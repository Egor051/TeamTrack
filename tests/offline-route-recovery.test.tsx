import 'fake-indexeddb/auto';
import { createElement, useCallback, useEffect, useState } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('expo-router', () => ({ useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) }));
vi.mock('@/lib/local-cache/driver', async () => import('@/lib/local-cache/driver.web'));
import { putCached, readThroughCache, isCachedResult } from '@/lib/local-cache/cache';
import { useOnlineRecovery } from '@/lib/connectivity/use-online-recovery';
import { reportBrowserConnectivity, reportConnectivitySuccess, usesLocalReads } from '@/lib/connectivity/state';
import { subscribeTable } from '@/lib/supabase/realtime';

const f = vi.hoisted(() => ({ channel: vi.fn(), remove: vi.fn(), session: vi.fn(async () => ({ data: { session: { user: { id: 'user-a' } } }, error: null })) }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { channel: f.channel, removeChannel: f.remove, auth: { getSession: f.session } },
  readPersistedSession: async () => ({ user: { id: 'user-a' } }) }));

let renderer: ReactTestRenderer | null = null;
let completedReads = 0;
const onlineRead = vi.fn(async () => [{ id: 'fresh' }]);
function Route() {
  const [view, setView] = useState('loading');
  const load = useCallback(async () => {
    const data = await readThroughCache<{ id: string }[]>('projects:active', onlineRead);
    completedReads += 1;
    setView(`${isCachedResult(data) ? 'offline' : 'online'}:${data[0].id}`);
  }, []);
  useEffect(() => { void load(); }, [load]);
  useOnlineRecovery(load);
  useEffect(() => subscribeTable('projects', { userId: '11111111-1111-4111-8111-111111111111', onEvent: () => undefined }), []);
  return createElement('Route', {}, view);
}
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  completedReads = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await putCached('user-a', 'projects:active', [{ id: 'cached' }]);
  vi.stubGlobal('navigator', { onLine: false }); reportBrowserConnectivity(false);
  f.channel.mockImplementation(() => { const channel = { on: () => channel, subscribe: () => channel }; return channel; });
});
afterEach(async () => {
  await act(async () => { renderer?.unmount(); renderer = null; });
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it('reads IndexedDB immediately, then re-enables HTTP and realtime on the mounted route across repeated recovery cycles', async () => {
  await act(async () => { renderer = create(createElement(Route)); });
  await vi.waitFor(async () => { await act(async () => undefined); expect(renderer!.toJSON()).toMatchObject({ children: ['offline:cached'] }); });
  expect(renderer!.toJSON()).toMatchObject({ children: ['offline:cached'] });
  expect(onlineRead).not.toHaveBeenCalled(); expect(f.channel).not.toHaveBeenCalled(); expect(f.session).not.toHaveBeenCalled();
  for (let cycle = 0; cycle < 3; cycle++) {
    if (cycle) { vi.stubGlobal('navigator', { onLine: false }); reportBrowserConnectivity(false); }
    vi.stubGlobal('navigator', { onLine: true });
    await act(async () => {
      reportConnectivitySuccess();
    });
    await vi.waitFor(async () => { await act(async () => undefined); expect(completedReads).toBe(cycle + 2); expect(renderer!.toJSON()).toMatchObject({ children: ['online:fresh'] }); });
    expect(usesLocalReads()).toBe(false);
    expect(renderer!.toJSON()).toMatchObject({ children: ['online:fresh'] });
    expect(onlineRead).toHaveBeenCalledTimes(cycle + 1);
    expect(f.channel).toHaveBeenCalledTimes(cycle + 1);
    expect(f.remove).toHaveBeenCalledTimes(cycle);
  }
  await act(async () => { renderer!.unmount(); renderer = null; });
  reportBrowserConnectivity(false); reportConnectivitySuccess();
  expect(onlineRead).toHaveBeenCalledTimes(3); expect(f.remove).toHaveBeenCalledTimes(3);
});
