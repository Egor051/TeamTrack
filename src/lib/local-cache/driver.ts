// Metro resolves driver.web.ts or driver.native.ts in app bundles.
// This fallback keeps Node unit tests independent of device storage.
import type { LocalCacheDriver, OfflineOperation } from './types';
import { reconcileEntries, reconciledKeys } from './reconcile';

const pending: OfflineOperation[] = [];
const entries = new Map<string, import('./types').CacheEntry>();
const entryKey = (userId: string, key: string) => `${userId}:${key}`;

export const localCacheDriver: LocalCacheDriver = {
  async get(userId, key) { return entries.get(entryKey(userId, key)) ?? null; },
  async put(entry) { entries.set(entryKey(entry.user_id, entry.key), entry); },
  async putIfUnchanged(entry, expectedData) {
    const key = entryKey(entry.user_id, entry.key);
    if ((entries.get(key)?.data ?? null) === expectedData) entries.set(key, entry);
  },
  async remove(userId, key) { entries.delete(entryKey(userId, key)); },
  async enqueue(operation) {
    const saved = { ...operation, sequence: pending.length + 1 };
    pending.push(saved);
    return saved;
  },
  async listPending(userId, taskId) {
    return pending.filter((operation) => operation.user_id === userId && (!taskId || operation.task_id === taskId));
  },
  async markOperation(userId, operationId, status, result, error) {
    const operation = pending.find((row) => row.user_id === userId && row.operation_id === operationId);
    if (operation) Object.assign(operation, { status, server_result: result, last_error: error ?? null });
  },
  async reconcileOperation(userId, operationId, item, activeSnapshot) {
    const index = pending.findIndex((row) => row.user_id === userId && row.operation_id === operationId);
    if (index < 0) return;
    const operation = pending[index];
    if (operation.status !== 'synced_unreconciled' || operation.task_item_id !== item.id) throw new Error('Invalid reconciliation');
    const keys = reconciledKeys(operation);
    const updated = reconcileEntries(keys.map((key) => entries.get(entryKey(userId, key)) ?? null), operation, item, activeSnapshot);
    keys.forEach((key, i) => {
      if (updated[i]) entries.set(entryKey(userId, key), updated[i]);
      else entries.delete(entryKey(userId, key));
    });
    pending.splice(index, 1);
  },
};
