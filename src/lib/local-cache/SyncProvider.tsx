import { useEffect, type ReactNode } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useAuth } from '@/features/auth/AuthProvider';
import { offlineSyncEnabled } from './outbox';
import { syncPendingOperations } from './sync';
import { subscribeTable } from '@/lib/supabase/realtime';
import { updateSyncState, forgetSyncState } from './status';

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
    const network = NetInfo.addEventListener((state) => {
      updateSyncState(userId, { connectivity: state.isConnected === false || state.isInternetReachable === false
        ? 'offline' : state.isConnected === true ? 'online' : 'unknown' });
      if (state.isConnected === true && state.isInternetReachable !== false) trigger(true);
    });
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') trigger();
    });
    const realtime = subscribeTable('task_items', { userId, onEvent: () => trigger() });
    const online = () => trigger(true);
    if (typeof window !== 'undefined') window.addEventListener('online', online);
    return () => {
      if (timer) clearTimeout(timer);
      network(); foreground.remove(); realtime();
      if (typeof window !== 'undefined') window.removeEventListener('online', online);
      forgetSyncState(userId);
    };
  }, [userId, sessionToken]);

  return children;
}
