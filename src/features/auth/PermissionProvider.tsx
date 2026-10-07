import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase/client';
import { subscribeToPermissionChanges, type RealtimeStatus } from '@/lib/supabase/realtime';
import { subscribeConnectivity, usesLocalReads } from '@/lib/connectivity/state';
import { activeCacheUserId, getCached, reconcileVisibleProjects } from '@/lib/local-cache/cache';
import { invalidateReadModels } from '@/lib/local-cache/read-freshness';
import { isExplicitAccessError } from '@/lib/connectivity/errors';

type PermissionContextValue = { version: number; status: RealtimeStatus };
const PermissionContext = createContext<PermissionContextValue>({ version: 0, status: 'disconnected' });
type Membership = { project_id: string; role: string };
const signature = (rows: Membership[]) => rows.map((row) => `${row.project_id}:${row.role}`).sort().join('|');

export function PermissionProvider({ userId, children }: { userId: string | null; children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<RealtimeStatus>('disconnected');
  useEffect(() => {
    if (!userId) return;
    let active = true;
    let pending: Promise<void> | null = null;
    let recheck = false;
    let previous: string | null = null;
    let connected = false;
    const invalidate = (install = true) => {
      // ACL signals quarantine cached models synchronously before a loader can
      // use them. Routes then perform authoritative RLS/RPC checks immediately.
      if (install) void invalidateReadModels(userId, undefined, 'access').catch(() => undefined);
      if (active) setVersion((current) => current + 1);
    };
    const revalidate = (): Promise<void> => {
      if (!active || usesLocalReads()) return Promise.resolve();
      if (pending) { recheck = true; return pending; }
      const task = (async () => {
        const cached = await Promise.all(['active', 'archived'].map((mode) => getCached<{ id: string; role: string }[]>(userId, `projects:${mode}`)));
        const rows: Membership[] = [];
        for (let from = 0; ; from += 500) {
          const result = await supabase.from('project_members').select('project_id,role').eq('user_id', userId).order('project_id').range(from, from + 499);
          if (result.error) { if (active && isExplicitAccessError(result.error)) invalidate(); return; }
          rows.push(...(result.data ?? []));
          if ((result.data?.length ?? 0) < 500) break;
        }
        if (!active || await activeCacheUserId() !== userId) return;
        const next = signature(rows);
        const known = previous ?? (cached.every(Boolean) ? signature(cached.flatMap((value) => value!).map((row) => ({ project_id: row.id, role: row.role }))) : null);
        previous = next;
        if (known !== null && known !== next) {
          invalidate();
          await reconcileVisibleProjects(userId, cached.flatMap((value) => value ?? []), rows.map((row) => ({ id: row.project_id })));
        }
      })().catch((error) => { if (active && isExplicitAccessError(error)) invalidate(); }).finally(() => {
        if (pending === task) pending = null;
        // A recheck starts after SUBSCRIBED/reconnect, closing the initial race.
        if (active && recheck) { recheck = false; void revalidate(); }
      });
      pending = task; return task;
    };
    const cleanup = subscribeToPermissionChanges(userId, (event) => {
      invalidate(false);
      if (event.table === 'project_members') void revalidate();
    }, (next) => {
      if (!active) return;
      setStatus(next);
      if (next === 'connected' && !connected) { connected = true; void revalidate(); }
      else if (next !== 'connected') connected = false;
    });
    const connectivity = subscribeConnectivity((next) => {
      if (next === 'online') {
        // Connectivity is not an ACL signal. Active loaders must check the
        // server, while inactive confirmed models remain usable if the device
        // goes offline again before those routes are opened.
        void invalidateReadModels(userId, undefined, 'refresh').catch(() => undefined);
        if (active) setVersion((current) => current + 1);
        void revalidate();
      }
    });
    const initial = setTimeout(() => { void revalidate(); }, 0);
    return () => { active = false; clearTimeout(initial); cleanup(); connectivity(); };
  }, [userId]);
  const value = useMemo(() => ({ version, status }), [status, version]);
  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}
export function usePermissionVersion(): number { return useContext(PermissionContext).version; }
export function usePermissionRealtimeStatus(): RealtimeStatus { return useContext(PermissionContext).status; }
