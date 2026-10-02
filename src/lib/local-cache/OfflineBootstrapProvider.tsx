import { useEffect, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { useAuth } from '@/features/auth/AuthProvider';
import { subscribeConnectivity, usesLocalReads } from '@/lib/connectivity/state';
import { subscribeMany } from '@/lib/supabase/realtime';
import { BOOTSTRAP_REFRESH_MS, bootstrapDelay, cancelAccountBootstrap, getBootstrapMetadata, runAccountBootstrap, subscribeBootstrap } from './bootstrap';

export function OfflineBootstrapProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const userId = state.isLoading ? null : state.user?.id ?? null;
  const token = state.isLoading ? null : state.session?.access_token ?? null;
  useEffect(() => {
    if (Platform.OS !== 'web' || !userId || typeof window === 'undefined') return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let force = false;
    let requestedAt = 0;
    let running = false;
    let connected = false;
    const schedule = (delay: number) => {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void refresh(); }, delay);
    };
    const refresh = async () => {
      if (disposed || running || usesLocalReads()) return;
      running = true;
      try {
        const before = await getBootstrapMetadata(userId);
        if (disposed) return;
        // Another tab's successful run can satisfy this tab's queued event.
        if (force && before.last_successful_sync_at && Date.parse(before.last_successful_sync_at) >= requestedAt) {
          force = false; requestedAt = 0;
        }
        if (!force && before.status === 'ready' && before.last_successful_sync_at
          && Date.now() - Date.parse(before.last_successful_sync_at) < BOOTSTRAP_REFRESH_MS) return;
        const delay = bootstrapDelay(before);
        if (delay > 0) { schedule(delay + 50); return; }
        const result = await runAccountBootstrap(userId, force);
        const after = await getBootstrapMetadata(userId);
        if (disposed) return;
        if (result === 'busy') { schedule(1000); return; }
        if (after.status === 'ready' && after.last_successful_sync_at && Date.parse(after.last_successful_sync_at) >= requestedAt) {
          force = false; requestedAt = 0;
        }
        if (after.status !== 'ready' || force) schedule(Math.max(400, bootstrapDelay(after) + 50));
      } catch (error) {
        if (!disposed) {
          console.warn('[TaskTrace] offline bootstrap failed', error);
          schedule(30_000);
        }
      } finally { running = false; }
    };
    const trigger = (revalidate = false) => {
      if (disposed) return;
      force ||= revalidate;
      if (revalidate) requestedAt = Date.now();
      // Coalesce a burst into one request and one completion callback/timer.
      if (!running) schedule(400);
    };
    trigger(true);
    const online = () => trigger(true);
    const connectivity = subscribeConnectivity((next) => { if (next === 'online') trigger(true); });
    const visible = () => { if (document.visibilityState === 'visible') trigger(); };
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visible);
    const foreground = AppState.addEventListener('change', (next) => { if (next === 'active') trigger(); });
    const realtime = subscribeMany(['projects', 'project_members', 'profiles', 'tasks', 'task_members', 'task_assignees',
      'task_items', 'audit_log', 'task_templates', 'task_template_items', 'notifications'].map((table) => ({
      table, options: { userId, onEvent: () => trigger(true), onStatus: (status) => {
        if (status === 'connected') { if (!connected) trigger(true); connected = true; }
        else if (status !== 'connecting') connected = false;
      } },
    })));
    // Metadata wakes passive tabs and scheme changes. State broadcasts never
    // force another server refresh, so page/lease writes cannot form a loop.
    const metadata = subscribeBootstrap((changedUser) => { if (changedUser === userId && !running) trigger(); });
    // Bounded manifest revalidation covers missed realtime events and entities
    // absent from the private item feed. It does not download unchanged data.
    const interval = setInterval(() => trigger(), BOOTSTRAP_REFRESH_MS);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      clearInterval(interval); realtime(); foreground.remove(); metadata(); connectivity();
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visible);
      cancelAccountBootstrap(userId);
    };
  }, [userId, token]);
  return children;
}
