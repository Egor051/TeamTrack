import { useCallback, useLayoutEffect, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { activeCacheUserId } from './cache';
import { subscribeReadModelCommits } from './read-model-events';
import { invalidateReadModels, isReadAccessPending, scopeReadPrefixes, type ReadScope } from './read-freshness';
import { createReadRefreshScheduler } from './refresh-scheduler';

export function useReadModelUpdates(load: () => Promise<unknown>, scope: ReadScope = {}) {
  const latest = useRef(load);
  useLayoutEffect(() => { latest.current = load; }, [load]);
  const scheduler = useRef<ReturnType<typeof createReadRefreshScheduler> | null>(null);
  const { projectId, taskId, userId, view } = scope;
  useFocusEffect(useCallback(() => {
    let active = true;
    const refresh = createReadRefreshScheduler(() => latest.current()); scheduler.current = refresh;
    const off = subscribeReadModelCommits((commit) => {
      void (async () => {
        const owner = await activeCacheUserId();
        if (!active || owner !== commit.userId) return;
        const prefixes = await scopeReadPrefixes(owner, { projectId, taskId, userId, view });
        if (active && commit.keys.some((key) => prefixes.some((prefix) => key.startsWith(prefix)))) refresh.request();
      })().catch(() => undefined);
    });
    return () => { active = false; off(); refresh.dispose(); if (scheduler.current === refresh) scheduler.current = null; };
  }, [projectId, taskId, userId, view]));
  const scheduleRefresh = useCallback(() => {
    scheduler.current?.request(isReadAccessPending(taskId ? `task:${taskId}` : projectId ? `project:${projectId}` : 'projects:active'));
  }, [projectId, taskId]);
  const refreshFromServer = useCallback(async () => {
    const owner = await activeCacheUserId();
    if (owner) await invalidateReadModels(owner, await scopeReadPrefixes(owner, { projectId, taskId, userId, view }), 'refresh');
    await latest.current();
  }, [projectId, taskId, userId, view]);
  return { scheduleRefresh, refreshFromServer };
}
