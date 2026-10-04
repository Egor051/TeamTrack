import { useEffect, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { useAuth } from '@/features/auth/AuthProvider';
import { getCurrentSession } from '@/features/auth/auth';
import { reportBrowserConnectivity, revalidateConnectivity, subscribeConnectivity, usesLocalReads } from '@/lib/connectivity/state';
import { subscribeMany } from '@/lib/supabase/realtime';
import { BOOTSTRAP_REFRESH_MS, bootstrapDelay, cancelAccountBootstrap, getBootstrapMetadata,
  resumeAccountBootstrap, retryAccountBootstrap, runAccountBootstrap, subscribeBootstrap } from './bootstrap';
import { cancelPendingSync, syncPendingOperations } from './sync';
import { createOfflineCoordinator } from './coordinator';
import { registerOfflineWork, requestOfflineWork } from './work-requests';

export function OfflineRuntimeProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const userId = state.isLoading ? null : state.user?.id ?? null;
  const token = state.session?.access_token ?? null;
  useEffect(() => {
    if (!userId) return;
    const coordinator = createOfflineCoordinator(userId, {
      local: usesLocalReads, probe: revalidateConnectivity,
      session: async () => { const { data, error } = await getCurrentSession(); return !error && data.session?.user.id === userId; },
      metadata: () => getBootstrapMetadata(userId),
      prepare: (mode, force) => mode === 'retry' ? retryAccountBootstrap(userId)
        : mode === 'resume' ? resumeAccountBootstrap(userId) : runAccountBootstrap(userId, force),
      sync: (force) => syncPendingOperations(userId, force),
      cancelPreparation: () => cancelAccountBootstrap(userId), cancelSync: () => cancelPendingSync(userId),
      delay: bootstrapDelay, refreshMs: BOOTSTRAP_REFRESH_MS, preloadEnabled: Platform.OS === 'web',
    });
    const registration = registerOfflineWork(userId, (reason) => coordinator.request(reason));
    void coordinator.request('startup');
    const connectivity = subscribeConnectivity((next) => {
      if (next === 'online') void coordinator.request('reconnect'); else coordinator.networkLost();
    });
    const nativeNetwork = Platform.OS === 'web' ? () => undefined : NetInfo.addEventListener((next) => {
      if (next.isConnected === false || next.isInternetReachable === false) reportBrowserConnectivity(false);
      else if (next.isConnected === true) reportBrowserConnectivity(true);
    });
    const foreground = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void coordinator.request('freshness');
    };
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') { if (Platform.OS !== 'web') void revalidateConnectivity(); foreground(); }
    });
    let connected = false;
    const realtime = subscribeMany(['projects', 'project_members', 'profiles', 'tasks', 'task_members', 'task_assignees',
      'task_items', 'audit_log', 'task_templates', 'task_template_items', 'notifications'].map((table) => ({
      table, options: { userId, onEvent: () => { void coordinator.request('invalidation'); }, onStatus: (status) => {
        if (status === 'connected') { if (!connected) void coordinator.request('freshness'); connected = true; }
        else if (status !== 'connecting') connected = false;
      } },
    })));
    const metadata = subscribeBootstrap((id) => { if (id === userId) void coordinator.request('freshness'); });
    const interval = setInterval(foreground, BOOTSTRAP_REFRESH_MS);
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', foreground); window.addEventListener('pageshow', foreground);
      document.addEventListener('visibilitychange', foreground);
    }
    return () => {
      registration(); connectivity(); nativeNetwork(); realtime(); metadata(); appState.remove(); clearInterval(interval);
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', foreground); window.removeEventListener('pageshow', foreground);
        document.removeEventListener('visibilitychange', foreground);
      }
      coordinator.dispose();
    };
  }, [userId]);
  useEffect(() => { if (userId && token) void requestOfflineWork(userId, 'freshness'); }, [userId, token]);
  return children;
}

// Compatibility export for callers of the old preload-only provider.
export const OfflineBootstrapProvider = OfflineRuntimeProvider;
