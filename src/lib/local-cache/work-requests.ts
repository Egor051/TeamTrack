export type OfflineWorkReason = 'startup' | 'reconnect' | 'retry' | 'scheme' | 'freshness' | 'invalidation' | 'mutations';
const handlers = new Map<string, (reason: OfflineWorkReason) => Promise<void>>();
export function registerOfflineWork(userId: string, handler: (reason: OfflineWorkReason) => Promise<void>): () => void {
  handlers.set(userId, handler);
  return () => { if (handlers.get(userId) === handler) handlers.delete(userId); };
}
export function requestOfflineWork(userId: string, reason: OfflineWorkReason): Promise<void> | null {
  return handlers.get(userId)?.(reason) ?? null;
}
