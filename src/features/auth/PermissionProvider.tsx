import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase/client';
import { subscribeToPermissionChanges, type RealtimeStatus } from '@/lib/supabase/realtime';

type PermissionContextValue = {
  version: number;
  status: RealtimeStatus;
};

const PermissionContext = createContext<PermissionContextValue>({ version: 0, status: 'disconnected' });

/**
 * Keeps the app's permission-dependent screens synchronized. Realtime events
 * only invalidate the cache; the queries below remain subject to RLS and are
 * the source of truth for the resulting permission state.
 */
export function PermissionProvider({ userId, children }: { userId: string | null; children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<RealtimeStatus>('disconnected');

  const revalidate = useCallback(async () => {
    if (!userId) return;
    const [projects, tasks, assignees] = await Promise.all([
      supabase.from('project_members').select('project_id,role').eq('user_id', userId),
      supabase.from('task_members').select('task_id').eq('user_id', userId),
      supabase.from('task_assignees').select('task_id').eq('user_id', userId),
    ]);
    if (projects.error || tasks.error || assignees.error) return;
    setVersion((current) => current + 1);
  }, [userId]);

  useEffect(() => {
    if (!userId) {
      return undefined;
    }
    let active = true;
    let initialConnectionRevalidated = false;
    const onStatus = (next: RealtimeStatus) => {
      if (active) setStatus(next);
      if (active && next === 'connected' && !initialConnectionRevalidated) {
        initialConnectionRevalidated = true;
        void revalidate();
      }
    };
    const cleanup = subscribeToPermissionChanges(userId, () => { void revalidate(); }, onStatus);
    // Revalidate once after subscribing, and again when the channel reaches
    // SUBSCRIBED, closing the initial-fetch/subscription race window.
    setTimeout(() => { void revalidate(); }, 0);
    return () => {
      active = false;
      cleanup();
    };
  }, [revalidate, userId]);

  const value = useMemo(() => ({ version, status }), [status, version]);
  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}

export function usePermissionVersion(): number {
  return useContext(PermissionContext).version;
}

export function usePermissionRealtimeStatus(): RealtimeStatus {
  return useContext(PermissionContext).status;
}
