import { activeCacheUserId } from './cache';
import { localCacheDriver } from './driver';
import { unresolvedConflicts } from './conflicts';
import { listPendingOperations } from './outbox';
import { getNetworkFacts, getOfflineRuntime, publishQueueFacts, publishSyncError, subscribeOfflineRuntime, type OperationTicket } from './runtime-state';
import { boundedOperation } from '@/lib/connectivity/deadline';
import type { LocalCacheDriver } from './types';

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

const listeners = new Set<(userId: string) => void>();
const reads = new Map<string, number>();
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
  const runtime = subscribeOfflineRuntime((id) => {
    if (id) listener(id);
    // Connectivity is a global fact, never an independent per-user flag.
    else void activeCacheUserId().then((userId) => { if (userId && listeners.has(listener)) listener(userId); });
  });
  return () => { listeners.delete(listener); runtime(); };
}
export function updateSyncState(userId: string, patch: Partial<SyncState>, ticket?: OperationTicket): void {
  if (ticket && !ticket.current()) return;
  if ('lastErrorKind' in patch) publishSyncError(userId, patch.lastErrorKind ?? null, ticket);
  if (ticket && ('isSyncing' in patch || 'progress' in patch)) ticket.update({
    ...('isSyncing' in patch ? { visible: patch.isSyncing } : {}),
    ...('progress' in patch ? { progress: patch.progress } : {}),
  });
  broadcast(userId);
}
export function notifySyncState(userId: string): void { broadcast(userId); }
export function forgetSyncState(userId: string): void { publishSyncError(userId, null); }

export async function markSuccessfulSync(userId: string, ticket?: OperationTicket, driver: LocalCacheDriver = localCacheDriver): Promise<void> {
  ticket?.assertCurrent();
  if (await activeCacheUserId() !== userId) return;
  await driver.put({ user_id: userId, key: 'sync:last-successful-at',
    data: JSON.stringify(new Date().toISOString()), last_synced_at: new Date().toISOString(), schema_version: 1 });
  ticket?.assertCurrent();
  updateSyncState(userId, { lastErrorKind: null }, ticket);
}

export async function getSyncState(userId: string): Promise<SyncState> {
  const epoch = getOfflineRuntime(userId).epoch;
  const read = (reads.get(userId) ?? 0) + 1; reads.set(userId, read);
  if (!userId || await activeCacheUserId() !== userId) throw new Error('Требуется авторизация.');
  const [operations, conflicts, last] = await boundedOperation(() => Promise.all([
    listPendingOperations(userId), unresolvedConflicts(userId), localCacheDriver.get(userId, 'sync:last-successful-at'),
  ]), 20_000);
  if (await activeCacheUserId() !== userId) throw new Error('Сеанс изменился.');
  const runtime = getOfflineRuntime(userId);
  const network = getNetworkFacts();
  const operation = runtime.operations.sync;
  const local = { connectivity: network.physical === 'disconnected' || network.backend === 'unavailable' ? 'offline' as const
    : network.backend === 'reachable' ? 'online' as const : 'unknown' as const,
    isSyncing: operation?.phase === 'running' && operation.visible,
    progress: operation?.phase === 'running' && operation.visible ? operation.progress : null,
    lastErrorKind: runtime.syncError };
  const value = last ? JSON.parse(last.data) as unknown : null;
  const queue = {
    pendingCount: operations.filter((row) => row.status === 'pending' || row.status === 'synced_unreconciled').length,
    unsyncedCount: operations.filter((row) => ['pending', 'synced_unreconciled', 'failed', 'conflict'].includes(row.status)).length,
    failedCount: operations.filter((row) => row.status === 'failed').length,
    conflictCount: conflicts.length,
    lastSuccessfulSyncAt: typeof value === 'string' ? value : null,
  };
  if (reads.get(userId) === read && getOfflineRuntime(userId).epoch === epoch) publishQueueFacts(userId, { ...queue, restored: true });
  return { ...local, ...queue };
}
