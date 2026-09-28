// Metro resolves driver.web.ts or driver.native.ts in app bundles.
// This fallback keeps Node unit tests independent of device storage.
import type { LocalCacheDriver, OfflineOperation } from './types';

const pending: OfflineOperation[] = [];

export const localCacheDriver: LocalCacheDriver = {
  async get() { return null; },
  async put() { return undefined; },
  async remove() { return undefined; },
  async enqueue(operation) {
    const saved = { ...operation, sequence: pending.length + 1 };
    pending.push(saved);
    return saved;
  },
  async listPending(userId, taskId) {
    return pending.filter((operation) => operation.user_id === userId && (!taskId || operation.task_id === taskId));
  },
};
