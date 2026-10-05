import { useEffect, useState } from 'react';
import { useAuth } from '@/features/auth/AuthProvider';
import { getBootstrapMetadata, subscribeBootstrap } from './bootstrap';
import { initialBootstrap, type BootstrapMetadata } from './bootstrap-types';
import { getUtcPlus3DayStart } from './day';
import { getOfflineRuntime, subscribeOfflineRuntime } from './runtime-state';

export function useOfflineBootstrap(): BootstrapMetadata | null {
  const { state } = useAuth();
  const userId = state.isLoading ? null : state.user?.id ?? null;
  const [metadata, setMetadata] = useState<BootstrapMetadata | null>(null);
  useEffect(() => {
    if (!userId) return;
    let active = true;
    let request = 0;
    const load = () => {
      const current = ++request;
      void getBootstrapMetadata(userId).then((value) => { if (active && current === request) setMetadata(value); })
        .catch(() => { if (active && current === request) setMetadata({ ...initialBootstrap(userId), status: 'error', error: 'Локальное хранилище недоступно.' }); });
    };
    load();
    let dayTimer: ReturnType<typeof setTimeout>;
    const refreshAtMidnight = () => {
      dayTimer = setTimeout(() => { load(); refreshAtMidnight(); },
        Math.max(100, Date.parse(getUtcPlus3DayStart()) + 86400000 - Date.now() + 50));
    };
    refreshAtMidnight();
    const cleanup = subscribeBootstrap((id) => { if (id === userId) load(); });
    let pipeline = JSON.stringify(getOfflineRuntime(userId).operations.pipeline ?? null);
    const runtime = subscribeOfflineRuntime((id) => {
      if (id === null) { load(); return; }
      if (id !== userId) return;
      const next = JSON.stringify(getOfflineRuntime(userId).operations.pipeline ?? null);
      if (pipeline !== next) { pipeline = next; load(); }
    });
    return () => { active = false; clearTimeout(dayTimer); cleanup(); runtime(); };
  }, [userId]);
  return userId ? metadata?.user_id === userId ? metadata : { ...initialBootstrap(userId), status: 'checking' } : null;
}
