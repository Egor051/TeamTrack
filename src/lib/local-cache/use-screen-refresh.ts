import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { userMessage } from '@/lib/errors/user-message';
import { requestOfflineWork } from './work-requests';

type ScreenRead = { active: boolean; refresh: () => Promise<unknown> };
const focusedReads = new Set<ScreenRead>();

export function registerScreenRefresh(refresh: () => Promise<unknown>) {
  const read: ScreenRead = { active: true, refresh };
  focusedReads.add(read);
  return () => { read.active = false; focusedReads.delete(read); };
}

// Register existing loaders only while their screen is focused. No new read,
// cache or synchronization pipeline is introduced here.
export function useScreenRefresh(refresh: () => Promise<unknown>) {
  const latest = useRef(refresh);
  useLayoutEffect(() => { latest.current = refresh; }, [refresh]);
  useFocusEffect(useCallback(() => registerScreenRefresh(() => latest.current()), []));
}

export function useAppRefresh(userId: string | undefined, pathname: string) {
  const scope = useMemo(() => ({ userId, pathname }), [userId, pathname]);
  const current = useRef<object | null>(scope);
  useLayoutEffect(() => { current.current = scope; return () => { current.current = null; }; }, [scope]);
  const running = useRef<{ scope: object; promise: Promise<void> } | null>(null);
  const [busy, setBusy] = useState<object | null>(null);
  const [feedback, setFeedback] = useState<{ scope: object; message: string } | null>(null);
  const refresh = useCallback((): Promise<void> => {
    if (running.current?.scope === scope) return running.current.promise;
    if (!userId || current.current !== scope) return Promise.resolve();
    const reads = [...focusedReads];
    setBusy(scope); setFeedback(null);
    const promise = (async () => {
      try {
        // The authoritative coordinator probes connectivity and joins sync /
        // preparation already in progress before the screen's normal reads.
        const result = await requestOfflineWork(userId, 'manual-refresh');
        if (current.current !== scope) return;
        const results = await Promise.allSettled(reads.map(async (read) => { if (read.active) await read.refresh(); }));
        if (current.current !== scope) return;
        const failure = results.find((read) => read.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        if (result?.error) setFeedback({ scope, message: result.error });
      } catch (error) {
        if (current.current === scope) setFeedback({ scope, message: userMessage(error, 'Не удалось обновить данные. Попробуйте ещё раз.') });
      }
    })().finally(() => {
      if (running.current?.promise === promise) running.current = null;
      if (current.current === scope) setBusy(null);
    });
    running.current = { scope, promise };
    return promise;
  }, [scope, userId]);
  return { refresh, refreshing: busy === scope, error: feedback?.scope === scope ? feedback.message : '' };
}
