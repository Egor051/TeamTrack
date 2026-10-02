import { useEffect, type ReactNode } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useAuth } from '@/features/auth/AuthProvider';
import { offlineSyncEnabled } from './outbox';
import { syncPendingOperations } from './sync';
import { subscribeTable } from '@/lib/supabase/realtime';
import { updateSyncState, forgetSyncState } from './status';
import { runtimeCapabilities } from './runtime-config';
import { getConnectivityState, reportBrowserConnectivity, subscribeConnectivity, usesLocalReads } from '@/lib/connectivity/state';

export function SyncProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const userId = state.isLoading ? null : state.user?.id ?? null;
  const sessionToken = state.isLoading ? null : state.session?.access_token ?? null;

  useEffect(() => {
    if (!userId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let forceRun = false;
    const run = () => {
      if (!offlineSyncEnabled()) return;
      const force = forceRun;
      forceRun = false;
      void syncPendingOperations(userId, force).catch((error) => {
        if (process.env.NODE_ENV !== 'production') console.warn('[TaskTrace] offline sync failed', error);
      });
    };
    const trigger = (force = false) => {
      forceRun ||= force;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; run(); }, 250);
    };
    trigger(true);
    // coordinatedRun skips network I/O offline; restore metadata independently.
    if (usesLocalReads())
      void runtimeCapabilities(userId).catch(() => undefined);
    const network = NetInfo.addEventListener((state) => {
      if (state.isConnected === false || state.isInternetReachable === false) reportBrowserConnectivity(false);
      else if (state.isConnected === true) reportBrowserConnectivity(true);
      updateSyncState(userId, { connectivity: getConnectivityState() === 'online' ? 'online' : 'offline' });
      if (state.isConnected === true && state.isInternetReachable !== false) trigger(true);
    });
    const connectivity = subscribeConnectivity((next) => {
      updateSyncState(userId, { connectivity: next === 'online' ? 'online' : 'offline' });
      if (next === 'online') trigger(true);
    });
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') trigger();
    });
    const realtime = subscribeTable('task_items', { userId, onEvent: () => trigger() });
    const online = () => trigger(true);
    if (typeof window !== 'undefined') window.addEventListener('online', online);
    return () => {
      if (timer) clearTimeout(timer);
      network(); foreground.remove(); realtime(); connectivity();
      if (typeof window !== 'undefined') window.removeEventListener('online', online);
      forgetSyncState(userId);
    };
  }, [userId, sessionToken]);

  return children;
}
