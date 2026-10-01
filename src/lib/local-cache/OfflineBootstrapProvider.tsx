import { useEffect, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { useAuth } from '@/features/auth/AuthProvider';
import { subscribeMany } from '@/lib/supabase/realtime';
import { BOOTSTRAP_REFRESH_MS, cancelAccountBootstrap, getBootstrapMetadata, runAccountBootstrap } from './bootstrap';

export function OfflineBootstrapProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const userId = state.isLoading ? null : state.user?.id ?? null;
  const token = state.isLoading ? null : state.session?.access_token ?? null;
  useEffect(() => {
    if (Platform.OS !== 'web' || !userId || typeof window === 'undefined') return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let force = false;
    const trigger = (revalidate = false) => {
      force ||= revalidate;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (disposed || navigator.onLine === false) return;
        const next = force; force = false;
        void runAccountBootstrap(userId, next).then(async () => {
          const meta = await getBootstrapMetadata(userId);
          if (!disposed && meta.status !== 'ready') {
            timer = setTimeout(() => trigger(true), meta.lease ? Math.max(1000, meta.lease.expires_at - Date.now() + 500) : 30_000);
          }
        }).catch((error) => console.warn('[TaskTrace] offline bootstrap failed', error));
      }, 400);
    };
    trigger(true);
    const online = () => trigger(true);
    const visible = () => { if (document.visibilityState === 'visible') trigger(); };
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', visible);
    const foreground = AppState.addEventListener('change', (next) => { if (next === 'active') trigger(); });
    const realtime = subscribeMany(['projects', 'project_members', 'profiles', 'tasks', 'task_members', 'task_assignees',
      'task_items', 'audit_log', 'task_templates', 'task_template_items', 'notifications'].map((table) => ({
      table, options: { userId, onEvent: () => trigger(true), onStatus: (status) => { if (status === 'connected') trigger(true); } },
    })));
    // Bounded manifest revalidation covers missed realtime events and entities
    // absent from the private item feed. It does not download unchanged data.
    const interval = setInterval(() => trigger(), BOOTSTRAP_REFRESH_MS);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      clearInterval(interval); realtime(); foreground.remove();
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', visible);
      cancelAccountBootstrap(userId);
    };
  }, [userId, token]);
  return children;
}
