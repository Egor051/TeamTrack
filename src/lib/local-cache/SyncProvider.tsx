import { useEffect, type ReactNode } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useAuth } from '@/features/auth/AuthProvider';
import { offlineSyncEnabled } from './outbox';
import { syncPendingOperations } from './sync';
import { subscribeTable } from '@/lib/supabase/realtime';

export function SyncProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const userId = state.isLoading ? null : state.user?.id ?? null;

  useEffect(() => {
    if (!userId || !offlineSyncEnabled()) return;
    const trigger = () => { void syncPendingOperations(userId).catch((error) => {
      if (process.env.NODE_ENV !== 'production') console.warn('[TaskTrace] offline sync failed', error);
    }); };
    trigger();
    const network = NetInfo.addEventListener((state) => {
      if (state.isConnected === true && state.isInternetReachable !== false) trigger();
    });
    const foreground = AppState.addEventListener('change', (state) => {
      if (state === 'active') trigger();
    });
    const realtime = subscribeTable('task_items', { userId, onEvent: trigger });
    const online = () => trigger();
    if (typeof window !== 'undefined') window.addEventListener('online', online);
    return () => {
      network(); foreground.remove(); realtime();
      if (typeof window !== 'undefined') window.removeEventListener('online', online);
    };
  }, [userId]);

  return children;
}
