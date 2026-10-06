export type OfflineWorkReason = 'startup' | 'reconnect' | 'retry' | 'scheme' | 'freshness' | 'tick' | 'sync-retry' | 'invalidation' | 'mutations' | 'manual-refresh';
export type SyncResult = { outcome: 'success' | 'partial' | 'waiting-network' | 'disabled' | 'blocked' | 'error'; error: string | null };
export type OfflineWorkResult = {
  outcome: 'success' | 'partial' | 'waiting-network' | 'error' | 'cancelled' | 'scheduled';
  sync: SyncResult | null;
  preparation: 'skipped' | 'ready' | 'partial' | 'busy';
  error: string | null;
};
const handlers = new Map<string, (reason: OfflineWorkReason, delayMs?: number) => Promise<OfflineWorkResult | void>>();
export function registerOfflineWork(userId: string, handler: (reason: OfflineWorkReason, delayMs?: number) => Promise<OfflineWorkResult | void>): () => void {
  handlers.set(userId, handler);
  return () => { if (handlers.get(userId) === handler) handlers.delete(userId); };
}
export function requestOfflineWork(userId: string, reason: OfflineWorkReason, delayMs?: number): Promise<OfflineWorkResult | void> | null {
  const handler = handlers.get(userId);
  return (delayMs === undefined ? handler?.(reason) : handler?.(reason, delayMs)) ?? null;
}
