// Metro resolves driver.web.ts or driver.native.ts in app bundles.
// This fallback keeps Node unit tests independent of device storage.
import type { LocalCacheDriver, OfflineOperation, SyncConflict } from './types';
import { reconcileEntries, reconciledKeys } from './reconcile';
import { applyPullToEntries, validSyncVersion } from './pull-cache';

const pending: OfflineOperation[] = [];
const entries = new Map<string, import('./types').CacheEntry>();
const conflicts = new Map<string, SyncConflict>();
const entryKey = (userId: string, key: string) => `${userId}:${key}`;

export const localCacheDriver: LocalCacheDriver = {
  async commitCacheBatch(userId, batch, removeKeys = [], guards = []) {
    if (batch.some((entry) => entry.user_id !== userId)) throw new Error('Cache batch user mismatch');
    if (guards.some((guard) => (entries.get(entryKey(userId, guard.key))?.data ?? null) !== guard.data)) return false;
    for (const key of removeKeys) entries.delete(entryKey(userId, key));
    for (const entry of batch) entries.set(entryKey(userId, entry.key), entry);
    return true;
  },
  async get(userId, key) { return entries.get(entryKey(userId, key)) ?? null; },
  async put(entry) { entries.set(entryKey(entry.user_id, entry.key), entry); },
  async putIfUnchanged(entry, expectedData) {
    const key = entryKey(entry.user_id, entry.key);
    if ((entries.get(key)?.data ?? null) === expectedData) entries.set(key, entry);
  },
  async remove(userId, key) { entries.delete(entryKey(userId, key)); },
  async listEntries(userId, prefix = '') { return [...entries.values()].filter((entry) => entry.user_id === userId && entry.key.startsWith(prefix)); },
  async enqueue(operation) {
    const chain = pending.filter((row) => row.user_id === operation.user_id && row.task_item_id === operation.task_item_id)
      .sort((a, b) => a.sequence - b.sequence);
    const predecessor = chain.at(-1);
    const entry = entries.get(entryKey(operation.user_id, `items:${operation.task_id}:active`));
    const item = entry && (JSON.parse(entry.data) as { id: string; sync_version?: number }[]).find((row) => row.id === operation.task_item_id);
    if (!predecessor && !validSyncVersion(item?.sync_version))
      throw new Error('Для офлайн-редактирования сначала синхронизируйте данные при подключении к интернету.');
    if (predecessor?.status === 'failed' || predecessor?.status === 'conflict'
      || (predecessor && !validSyncVersion(chain[0].expected_version) && !chain[0].depends_on_operation_id))
      throw new Error('Сначала разрешите несинхронизированные изменения пункта.');
    const saved = { ...operation, sequence: pending.length + 1,
      expected_version: predecessor?.status === 'synced_unreconciled' && validSyncVersion(predecessor.server_version)
        ? predecessor.server_version : predecessor ? null
          : validSyncVersion(operation.expected_version) ? operation.expected_version : item!.sync_version!,
      depends_on_operation_id: predecessor?.operation_id ?? null };
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
  async acknowledgeOperation(userId, operationId, version, conflictId, item) {
    const operation = pending.find((row) => row.user_id === userId && row.operation_id === operationId);
    if (!operation) return;
    operation.status = 'synced_unreconciled'; operation.server_version = version;
    for (const row of pending) if (row.user_id === userId && row.depends_on_operation_id === operationId)
      { row.expected_version = version; row.depends_on_operation_id = null; }
    if (conflictId && item) {
      const conflict = conflicts.get(conflictId);
      if (conflict?.user_id === userId && conflict.operation_ids.includes(operationId))
        conflicts.set(conflictId, { ...conflict, server_state: item, server_version: version,
          updated_at: new Date().toISOString() });
    }
  },
  async listConflicts(userId) { return [...conflicts.values()].filter((row) => row.user_id === userId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.conflict_id.localeCompare(b.conflict_id)); },
  async createConflict(conflict) {
    const old = conflicts.get(conflict.conflict_id);
    conflicts.set(conflict.conflict_id, { ...conflict, created_at: old?.created_at ?? conflict.created_at });
    for (const row of pending) if (row.user_id === conflict.user_id && conflict.operation_ids.includes(row.operation_id)) row.status = 'conflict';
  },
  async rebaseConflict(userId, conflictId, version) {
    const conflict = conflicts.get(conflictId);
    if (!conflict || conflict.user_id !== userId) throw new Error('Conflict unavailable');
    const first = pending.filter((row) => row.user_id === userId && conflict.operation_ids.includes(row.operation_id))
      .sort((a, b) => a.sequence - b.sequence).find((row) => row.status !== 'synced_unreconciled');
    for (const row of pending) if (row.user_id === userId && conflict.operation_ids.includes(row.operation_id)
      && row.status !== 'synced_unreconciled') {
      row.status = 'pending';
      if (row.operation_id === first?.operation_id) row.expected_version = version;
    }
  },
  async resolveServerConflict(userId, conflictId) {
    const conflict = conflicts.get(conflictId);
    if (!conflict || conflict.user_id !== userId) throw new Error('Conflict unavailable');
    const before = [...entries.values()].filter((entry) => entry.user_id === userId);
    const after = applyPullToEntries(before, [{ cursor: 0, task_id: conflict.task_id, task_item_id: conflict.task_item_id,
      change_type: conflict.server_state ? 'upsert' : 'delete', item: conflict.server_state }], conflict.project_id);
    for (const entry of before) entries.delete(entryKey(userId, entry.key));
    for (const entry of after) entries.set(entryKey(userId, entry.key), entry);
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].user_id === userId && conflict.operation_ids.includes(pending[i].operation_id)) pending.splice(i, 1);
    conflicts.delete(conflictId);
  },
  async finishMineConflict(userId, conflictId) { if (conflicts.get(conflictId)?.user_id === userId) conflicts.delete(conflictId); },
  async discardFailedChain(userId, taskId, itemId, projectId, serverState) {
    const chain = pending.filter((row) => row.user_id === userId && row.task_id === taskId && row.task_item_id === itemId);
    if (!chain.some((row) => row.status === 'failed')) throw new Error('Failed operation unavailable');
    const before = [...entries.values()].filter((entry) => entry.user_id === userId);
    const after = applyPullToEntries(before, [{ cursor: 0, task_id: taskId, task_item_id: itemId,
      change_type: serverState ? 'upsert' : 'delete', item: serverState }], projectId);
    for (const entry of before) entries.delete(entryKey(userId, entry.key));
    for (const entry of after) entries.set(entryKey(userId, entry.key), entry);
    for (let i = pending.length - 1; i >= 0; i--) if (chain.includes(pending[i])) pending.splice(i, 1);
  },
  async initializePullCursor(userId, cursor) {
    if (entries.has(entryKey(userId, 'sync:task-items:cursor'))) return false;
    entries.set(entryKey(userId, 'sync:task-items:cursor'), { user_id: userId, key: 'sync:task-items:cursor',
      data: JSON.stringify(cursor), last_synced_at: new Date().toISOString(), schema_version: 1 });
    return true;
  },
  async applyPullPage(userId, afterCursor, nextCursor, changes) {
    const cursorEntry = entries.get(entryKey(userId, 'sync:task-items:cursor'));
    if (Number(JSON.parse(cursorEntry?.data ?? '0')) !== afterCursor) return false;
    const before = [...entries.values()].filter((entry) => entry.user_id === userId);
    let after = before;
    for (const change of changes) {
      const task = before.find((entry) => entry.key === `task:${change.task_id}`);
      const projectId = task ? (JSON.parse(task.data) as { project_id?: string }).project_id : undefined;
      after = applyPullToEntries(after, [change], projectId);
    }
    for (const entry of before) entries.delete(entryKey(userId, entry.key));
    for (const entry of after) entries.set(entryKey(userId, entry.key), entry);
    entries.set(entryKey(userId, 'sync:task-items:cursor'), { user_id: userId, key: 'sync:task-items:cursor',
      data: JSON.stringify(nextCursor), last_synced_at: new Date().toISOString(), schema_version: 1 });
    return true;
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
