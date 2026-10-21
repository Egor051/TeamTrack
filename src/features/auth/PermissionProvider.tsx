import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase/client';
import { subscribeToPermissionChanges, type RealtimeStatus } from '@/lib/supabase/realtime';
import { subscribeConnectivity, usesLocalReads } from '@/lib/connectivity/state';
import { activeCacheUserId, getCached, reconcileVisibleProjects } from '@/lib/local-cache/cache';
import { invalidateReadModels, readAccountEpoch } from '@/lib/local-cache/read-freshness';
import { cacheAccessEpoch } from '@/lib/local-cache/access-state';
import { isExplicitAccessError } from '@/lib/connectivity/errors';
import { uiRead } from '@/lib/supabase/ui-read';
import { boundedOperation } from '@/lib/connectivity/deadline';

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
    let checkGeneration = 0;
    let controller: AbortController | null = null;
    const lifetime = new AbortController();
    const effectAccount = readAccountEpoch();
    const invalidate = (install = true, signal?: AbortSignal) => {
      if (!active || readAccountEpoch() !== effectAccount || signal?.aborted) return Promise.resolve();
      // ACL signals quarantine cached models synchronously before a loader can
      // use them. Routes then perform authoritative RLS/RPC checks immediately.
      const persistence = install ? invalidateReadModels(userId, undefined, 'access', signal).catch(() => undefined) : Promise.resolve();
      if (active) setVersion((current) => current + 1);
      return persistence;
    };
    const revalidate = (restart = false): Promise<void> => {
      if (!active || usesLocalReads()) return Promise.resolve();
      if (restart) { controller?.abort(); pending = null; recheck = false; }
      if (pending) { recheck = true; return pending; }
      const generation = ++checkGeneration;
      const account = readAccountEpoch(), accessBaseline = cacheAccessEpoch();
      const checkController = new AbortController();
      controller = checkController;
      let live = true;
      const current = () => live && active && generation === checkGeneration && readAccountEpoch() === account && !checkController.signal.aborted;
      const task = boundedOperation(async (signal) => {
        const valid = () => current() && !signal.aborted;
        const cached = await Promise.all(['active', 'archived'].map((mode) => getCached<{ id: string; role: string }[]>(userId, `projects:${mode}`)));
        if (!valid()) return;
        const rows: Membership[] = [];
        for (let from = 0; ; from += 500) {
          const result = await uiRead(supabase.from('project_members').select('project_id,role').eq('user_id', userId).order('project_id').range(from, from + 499), signal);
          if (!valid()) return;
          if (result.error) { if (isExplicitAccessError(result.error)) await invalidate(true, signal); return; }
          rows.push(...(result.data ?? []));
          if ((result.data?.length ?? 0) < 500) break;
        }
        if (!valid() || await activeCacheUserId() !== userId || !valid()) return;
        const next = signature(rows);
        const known = previous ?? (cached.every(Boolean) ? signature(cached.flatMap((value) => value!).map((row) => ({ project_id: row.id, role: row.role }))) : null);
        if (known !== null && known !== next) {
          await invalidate(true, signal);
          if (!valid()) return;
          await reconcileVisibleProjects(userId, cached.flatMap((value) => value ?? []), rows.map((row) => ({ id: row.project_id })), accessBaseline, signal);
        }
        if (valid()) previous = next;
      }, 10_000, checkController.signal).catch((error) => { if (current() && isExplicitAccessError(error)) void invalidate(true, checkController.signal); }).finally(() => {
        const retry = current() && recheck;
        live = false;
        checkController.abort();
        if (pending === task) pending = null;
        // A recheck starts after SUBSCRIBED/reconnect, closing the initial race.
        if (retry) { recheck = false; void revalidate(); }
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
      if (!active || readAccountEpoch() !== effectAccount) return;
      if (next === 'online') {
        // Connectivity is not an ACL signal. Active loaders must check the
        // server, while inactive confirmed models remain usable if the device
        // goes offline again before those routes are opened.
        void invalidateReadModels(userId, undefined, 'refresh', lifetime.signal).catch(() => undefined);
        if (active) setVersion((current) => current + 1);
        void revalidate(true);
      }
    });
    const initial = setTimeout(() => { void revalidate(); }, 0);
    return () => { active = false; checkGeneration++; controller?.abort(); lifetime.abort(); clearTimeout(initial); cleanup(); connectivity(); };
  }, [userId]);
  const value = useMemo(() => ({ version, status }), [status, version]);
  return <PermissionContext.Provider value={value}>{children}</PermissionContext.Provider>;
}
export function usePermissionVersion(): number { return useContext(PermissionContext).version; }
export function usePermissionRealtimeStatus(): RealtimeStatus { return useContext(PermissionContext).status; }
