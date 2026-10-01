import { activeCacheUserId } from './cache';
import { localCacheDriver } from './driver';
import { unresolvedConflicts } from './conflicts';
import { listPendingOperations } from './outbox';

export type SyncState = {
  connectivity: 'unknown' | 'offline' | 'online';
  isSyncing: boolean;
  pendingCount: number;
  unsyncedCount: number;
  failedCount: number;
  conflictCount: number;
  lastSuccessfulSyncAt: string | null;
  lastErrorKind: string | null;
  progress: { done: number; total: number } | null;
};

const volatile = new Map<string, Pick<SyncState, 'connectivity' | 'isSyncing' | 'lastErrorKind' | 'progress'>>();
const listeners = new Set<(userId: string) => void>();
let channel: BroadcastChannel | null = null;
function broadcast(userId: string): void {
  for (const listener of listeners) listener(userId);
  if (typeof BroadcastChannel !== 'undefined' && typeof window !== 'undefined') {
    channel ??= new BroadcastChannel('tasktrace-sync-status');
    channel.postMessage({ type: 'changed', user_id: userId });
  }
}
export function subscribeSyncState(listener: (userId: string) => void): () => void {
  listeners.add(listener);
  if (typeof BroadcastChannel !== 'undefined' && typeof window !== 'undefined') {
    channel ??= new BroadcastChannel('tasktrace-sync-status');
    channel.onmessage = (event: MessageEvent) => {
      const value = event.data as { type?: string; user_id?: string } | null;
      if (value?.type === 'changed' && typeof value.user_id === 'string')
        for (const callback of listeners) callback(value.user_id);
    };
  }
  return () => { listeners.delete(listener); };
}
export function updateSyncState(userId: string, patch: Partial<SyncState>): void {
  const previous = volatile.get(userId) ?? { connectivity: 'unknown', isSyncing: false, lastErrorKind: null, progress: null };
  volatile.set(userId, { ...previous, ...patch });
  broadcast(userId);
}
export function notifySyncState(userId: string): void { broadcast(userId); }
export function forgetSyncState(userId: string): void { volatile.delete(userId); }

export async function markSuccessfulSync(userId: string): Promise<void> {
  if (await activeCacheUserId() !== userId) return;
  await localCacheDriver.put({ user_id: userId, key: 'sync:last-successful-at',
    data: JSON.stringify(new Date().toISOString()), last_synced_at: new Date().toISOString(), schema_version: 1 });
  updateSyncState(userId, { lastErrorKind: null });
}

export async function getSyncState(userId: string): Promise<SyncState> {
  if (!userId || await activeCacheUserId() !== userId) throw new Error('Требуется авторизация.');
  const [operations, conflicts, last] = await Promise.all([
    listPendingOperations(userId), unresolvedConflicts(userId), localCacheDriver.get(userId, 'sync:last-successful-at'),
  ]);
  if (await activeCacheUserId() !== userId) throw new Error('Сеанс изменился.');
  const local = volatile.get(userId) ?? { connectivity: 'unknown', isSyncing: false, lastErrorKind: null, progress: null };
  const value = last ? JSON.parse(last.data) as unknown : null;
  return { ...local,
    pendingCount: operations.filter((row) => row.status === 'pending' || row.status === 'synced_unreconciled').length,
    unsyncedCount: operations.filter((row) => ['pending', 'synced_unreconciled', 'failed', 'conflict'].includes(row.status)).length,
    failedCount: operations.filter((row) => row.status === 'failed').length,
    conflictCount: conflicts.length,
    lastSuccessfulSyncAt: typeof value === 'string' ? value : null,
  };
}
