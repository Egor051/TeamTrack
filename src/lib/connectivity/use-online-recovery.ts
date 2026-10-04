import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { subscribeConnectivity, usesLocalReads } from './state';

// A cached read is a read path, not a permanent page mode. Only the focused
// route reloads, once transport has actually recovered (not navigator.onLine).
export function useOnlineRecovery(reload: () => Promise<unknown>) {
  useFocusEffect(useCallback(() => {
    let local = usesLocalReads();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeConnectivity((next) => {
      const recovered = local && next === 'online';
      local = next !== 'online';
      if (recovered && !timer) timer = setTimeout(() => { timer = null; void reload().catch(() => undefined); }, 0);
    });
    return () => { unsubscribe(); if (timer) clearTimeout(timer); };
  }, [reload]));
}
