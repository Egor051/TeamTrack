import type { CacheEntry, LocalCacheDriver, OfflineOperation, OfflineOperationInput, SyncConflict } from './types';
import { reconcileEntries, reconciledKeys } from './reconcile';
import { applyPullToEntries, validSyncVersion } from './pull-cache';
import { boundedOperation } from '@/lib/connectivity/deadline';

const DB_NAME = 'tasktrace-local-cache';
const STORE = 'entries';
const OUTBOX = 'pending_operations';
const CONFLICTS = 'sync_conflicts';
const pullKey = 'sync:task-items:cursor';

function openDatabase(signal?: AbortSignal): Promise<IDBDatabase> {
  return boundedOperation((deadline) => new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 5);
    let blocked = false;
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(OUTBOX)) {
        const outbox = db.createObjectStore(OUTBOX, { keyPath: 'sequence', autoIncrement: true });
        outbox.createIndex('by_operation_id', 'operation_id', { unique: true });
        outbox.createIndex('by_user', 'user_id');
        outbox.createIndex('by_user_task', ['user_id', 'task_id']);
      }
      if (!db.objectStoreNames.contains(CONFLICTS)) {
        const conflicts = db.createObjectStore(CONFLICTS, { keyPath: 'conflict_id' });
        conflicts.createIndex('by_user', 'user_id');
      }
    };
    request.onsuccess = () => {
      if (blocked || deadline.aborted) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Обновление локального хранилища заблокировано другой вкладкой. Закройте другие вкладки TaskTrace и повторите.'));
    };
  }), 10_000, signal);
}

function entryKey(userId: string, key: string): string {
  return `${userId}:${key}`;
}

async function transactBase<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, resolve: (value: T) => void) => void, storeName = STORE, signal?: AbortSignal): Promise<T> {
  const db = await openDatabase(signal);
  try {
    return await boundedOperation((deadline) => new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const abort = () => { try { tx.abort(); } catch { /* Already committed/aborted. */ } };
      deadline.addEventListener('abort', abort, { once: true });
      const finish = () => deadline.removeEventListener('abort', abort);
      let value: T;
      tx.oncomplete = () => { finish(); resolve(value); };
      tx.onerror = (event) => { finish(); reject((event.target as IDBRequest).error ?? tx.error ?? new Error('IndexedDB transaction failed')); };
      tx.onabort = () => { finish(); reject(tx.error ?? new Error('IndexedDB transaction aborted')); };
      action(tx.objectStore(storeName), (result) => { value = result; });
    }), 10_000, signal);
  } finally {
    db.close();
  }
}

function operationTransaction(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode, signal?: AbortSignal): IDBTransaction {
  if (signal?.aborted) throw Object.assign(new Error('Operation cancelled'), { name: 'AbortError' });
  const tx = db.transaction(stores, mode);
  const abort = () => { try { tx.abort(); } catch { /* Transaction already settled. */ } };
  const timer = setTimeout(abort, 10_000);
  signal?.addEventListener('abort', abort, { once: true });
  const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
  tx.addEventListener('complete', cleanup, { once: true }); tx.addEventListener('error', cleanup, { once: true });
  tx.addEventListener('abort', cleanup, { once: true });
  return tx;
}

function operationDriver(parent?: AbortSignal): LocalCacheDriver {
  const transact = <T,>(mode: IDBTransactionMode, action: (store: IDBObjectStore, resolve: (value: T) => void) => void, storeName = STORE, signal?: AbortSignal) =>
    transactBase(mode, action, storeName, signal ?? parent);
  return {
  withOperation: operationDriver,
  async commitCacheBatch(userId, entries, removeKeys = [], guards = [], signal) {
    if (entries.some((entry) => entry.user_id !== userId)) throw new Error('Cache batch user mismatch');
    return transact<boolean>('readwrite', (store, resolve) => {
      let remaining = guards.length;
      let valid = true;
      const commit = () => {
        if (valid) {
          for (const key of removeKeys) store.delete(entryKey(userId, key));
          for (const entry of entries) store.put(entry, entryKey(userId, entry.key));
        }
        resolve(valid);
      };
      if (!remaining) { commit(); return; }
      for (const guard of guards) {
        const request = store.get(entryKey(userId, guard.key));
        request.onsuccess = () => {
          valid &&= ((request.result as CacheEntry | undefined)?.data ?? null) === guard.data;
          if (--remaining === 0) commit();
        };
      }
    }, STORE, signal);
  },
  get: (userId, key) => transact<CacheEntry | null>('readonly', (store, resolve) => {
    const request = store.get(entryKey(userId, key));
    request.onsuccess = () => resolve((request.result as CacheEntry | undefined) ?? null);
  }),
  put: (entry) => transact<void>('readwrite', (store, resolve) => {
    store.put(entry, entryKey(entry.user_id, entry.key));
    resolve();
  }),
  putIfUnchanged: (entry, expectedData) => transact<boolean>('readwrite', (store, resolve) => {
    const key = entryKey(entry.user_id, entry.key);
    const request = store.get(key);
    request.onsuccess = () => {
      const unchanged = ((request.result as CacheEntry | undefined)?.data ?? null) === expectedData;
      if (unchanged) store.put(entry, key);
      resolve(unchanged);
    };
  }),
  remove: (userId, key) => transact<void>('readwrite', (store, resolve) => {
    store.delete(entryKey(userId, key));
    resolve();
  }),
  listEntries: (userId, prefix = '') => transact<CacheEntry[]>('readonly', (store, resolve) => {
    const first = entryKey(userId, prefix);
    const request = store.getAll(IDBKeyRange.bound(first, `${first}\uffff`));
    request.onsuccess = () => resolve((request.result as CacheEntry[])
      .filter((entry) => entry.user_id === userId && entry.key.startsWith(prefix)));
  }),
  async enqueue(operation: OfflineOperationInput) {
    const db = await openDatabase(parent);
    let semanticError: Error | null = null;
    try {
      return await new Promise<OfflineOperation>((resolve, reject) => {
        const tx = operationTransaction(db, [OUTBOX, STORE], 'readwrite', parent);
        const outbox = tx.objectStore(OUTBOX);
        const cache = tx.objectStore(STORE);
        let saved: OfflineOperation;
        tx.oncomplete = () => resolve(saved);
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB enqueue failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB enqueue aborted'));
        const pendingRequest = outbox.index('by_user_task').getAll([operation.user_id, operation.task_id]);
        pendingRequest.onsuccess = () => {
          const chain = (pendingRequest.result as OfflineOperation[])
            .filter((row) => row.task_item_id === operation.task_item_id).sort((a, b) => a.sequence - b.sequence);
          if (chain.some((row) => row.status === 'failed' || row.status === 'conflict')) {
            semanticError = new Error('Сначала разрешите несинхронизированные изменения пункта.');
            tx.abort(); return;
          }
          const predecessor = chain.at(-1);
          const entryRequest = cache.get(entryKey(operation.user_id, `items:${operation.task_id}:active`));
          entryRequest.onsuccess = () => {
            try {
              const active = entryRequest.result as CacheEntry | undefined;
              const item = active ? (JSON.parse(active.data) as { id: string; sync_version?: number }[])
                .find((row) => row.id === operation.task_item_id) : undefined;
              if (!predecessor && !validSyncVersion(item?.sync_version)) {
                semanticError = new Error('Для офлайн-редактирования сначала синхронизируйте данные при подключении к интернету.');
                tx.abort(); return;
              }
              if (predecessor && !validSyncVersion(chain[0].expected_version) && !chain[0].depends_on_operation_id) {
                semanticError = new Error('Сначала разрешите несинхронизированные изменения пункта.');
                tx.abort(); return;
              }
              const candidate: OfflineOperationInput = { ...operation,
                expected_version: predecessor
                  ? (predecessor.status === 'synced_unreconciled' && validSyncVersion(predecessor.server_version)
                    ? predecessor.server_version : null)
                  : validSyncVersion(operation.expected_version) ? operation.expected_version : item!.sync_version!,
                depends_on_operation_id: predecessor?.operation_id ?? null };
              const add = outbox.add(candidate);
              add.onsuccess = () => {
                saved = { ...candidate, sequence: Number(add.result) };
                outbox.put(saved);
              };
            } catch { tx.abort(); }
          };
        };
      });
    } catch (error) {
      if (semanticError) throw semanticError;
      throw error;
    } finally { db.close(); }
  },
  listPending: (userId, taskId) => transact<OfflineOperation[]>('readonly', (store, resolve) => {
    const index = store.index(taskId ? 'by_user_task' : 'by_user');
    const request = index.getAll(taskId ? [userId, taskId] : userId);
    request.onsuccess = () => resolve((request.result as OfflineOperation[]).sort((a, b) => a.sequence - b.sequence));
  }, OUTBOX),
  markOperation: (userId, operationId, status, result, error) => transact<void>('readwrite', (store, resolve) => {
    const request = store.index('by_operation_id').get(operationId);
    request.onsuccess = () => {
      const operation = request.result as OfflineOperation | undefined;
      if (operation?.user_id === userId) store.put({ ...operation, status, server_result: result, last_error: error ?? null });
      resolve();
    };
  }, OUTBOX),
  async acknowledgeOperation(userId, operationId, version, conflictId, item) {
    const db = await openDatabase(parent);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = operationTransaction(db, conflictId ? [OUTBOX, CONFLICTS] : [OUTBOX], 'readwrite', parent);
        const store = tx.objectStore(OUTBOX);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB ACK failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB ACK aborted'));
        const request = store.index('by_operation_id').get(operationId);
        request.onsuccess = () => {
          const operation = request.result as OfflineOperation | undefined;
          if (!operation || operation.user_id !== userId) return;
          store.put({ ...operation, status: 'synced_unreconciled', server_version: version });
          const following = store.index('by_user_task').getAll([userId, operation.task_id]);
          following.onsuccess = () => {
            for (const row of following.result as OfflineOperation[]) {
              if (row.depends_on_operation_id === operationId && row.task_item_id === operation.task_item_id)
                store.put({ ...row, expected_version: version, depends_on_operation_id: null });
            }
            if (conflictId && item) {
              const conflicts = tx.objectStore(CONFLICTS);
              const conflictRequest = conflicts.get(conflictId);
              conflictRequest.onsuccess = () => {
                const conflict = conflictRequest.result as SyncConflict | undefined;
                if (conflict?.user_id === userId && conflict.operation_ids.includes(operationId))
                  conflicts.put({ ...conflict, server_state: item, server_version: version,
                    updated_at: new Date().toISOString() });
              };
            }
          };
        };
      });
    } finally { db.close(); }
  },
  listConflicts: (userId) => transact<SyncConflict[]>('readonly', (store, resolve) => {
    const request = store.index('by_user').getAll(userId);
    request.onsuccess = () => resolve((request.result as SyncConflict[])
      .filter((row) => row.user_id === userId && row.status === 'unresolved')
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.conflict_id.localeCompare(b.conflict_id)));
  }, CONFLICTS),
  async createConflict(conflict) {
    const db = await openDatabase(parent);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = operationTransaction(db, [CONFLICTS, OUTBOX], 'readwrite', parent);
        const store = tx.objectStore(CONFLICTS);
        const outbox = tx.objectStore(OUTBOX);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('Conflict storage failed'));
        tx.onabort = () => reject(tx.error ?? new Error('Conflict storage aborted'));
        const existing = store.get(conflict.conflict_id);
        existing.onsuccess = () => {
          const old = existing.result as SyncConflict | undefined;
          if (old && old.user_id !== conflict.user_id) { tx.abort(); return; }
          store.put({ ...conflict, created_at: old?.created_at ?? conflict.created_at });
          const request = outbox.index('by_user_task').getAll([conflict.user_id, conflict.task_id]);
          request.onsuccess = () => {
            for (const operation of request.result as OfflineOperation[]) {
              if (conflict.operation_ids.includes(operation.operation_id) && operation.task_item_id === conflict.task_item_id)
                outbox.put({ ...operation, status: 'conflict' });
            }
          };
        };
      });
    } finally { db.close(); }
  },
  async rebaseConflict(userId, conflictId, version) {
    const db = await openDatabase(parent);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = operationTransaction(db, [CONFLICTS, OUTBOX], 'readwrite', parent);
        const conflicts = tx.objectStore(CONFLICTS);
        const outbox = tx.objectStore(OUTBOX);
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed')); tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        const request = conflicts.get(conflictId);
        request.onsuccess = () => {
          const conflict = request.result as SyncConflict | undefined;
          if (!conflict || conflict.user_id !== userId || !conflict.operation_ids.length) { tx.abort(); return; }
          const all = outbox.index('by_user_task').getAll([userId, conflict.task_id]);
          all.onsuccess = () => {
            const chain = (all.result as OfflineOperation[]).filter((row) => conflict.operation_ids.includes(row.operation_id))
              .sort((a, b) => a.sequence - b.sequence);
            const firstUnconfirmed = chain.find((row) => row.status !== 'synced_unreconciled');
            for (const row of chain) {
              if (row.status === 'synced_unreconciled') continue;
              outbox.put({ ...row, status: 'pending',
                expected_version: row.operation_id === firstUnconfirmed?.operation_id ? version : row.expected_version });
            }
          };
        };
      });
    } finally { db.close(); }
  },
  async resolveServerConflict(userId, conflictId) {
    const db = await openDatabase(parent);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = operationTransaction(db, [CONFLICTS, OUTBOX, STORE], 'readwrite', parent);
        const conflicts = tx.objectStore(CONFLICTS), outbox = tx.objectStore(OUTBOX), cache = tx.objectStore(STORE);
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed')); tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        const request = conflicts.get(conflictId);
        request.onsuccess = () => {
          const conflict = request.result as SyncConflict | undefined;
          if (!conflict || conflict.user_id !== userId) { tx.abort(); return; }
          const all = outbox.index('by_user_task').getAll([userId, conflict.task_id]);
          all.onsuccess = () => {
            for (const row of all.result as OfflineOperation[]) {
              if (row.task_item_id === conflict.task_item_id && conflict.operation_ids.includes(row.operation_id)) outbox.delete(row.sequence);
            }
            const entriesRequest = cache.getAll();
            entriesRequest.onsuccess = () => {
              try {
                const entries = (entriesRequest.result as CacheEntry[]).filter((entry) => entry.user_id === userId);
                const next = applyPullToEntries(entries, [{ cursor: 0, task_id: conflict.task_id,
                  task_item_id: conflict.task_item_id, change_type: conflict.server_state ? 'upsert' : 'delete',
                  item: conflict.server_state }], conflict.project_id);
                for (const entry of next) cache.put(entry, entryKey(userId, entry.key));
                for (const entry of entries) if (!next.some((row) => row.key === entry.key)) cache.delete(entryKey(userId, entry.key));
                conflicts.delete(conflictId);
              } catch { tx.abort(); }
            };
          };
        };
      });
    } finally { db.close(); }
  },
  finishMineConflict: (userId, conflictId) => transact<void>('readwrite', (store, resolve) => {
    const request = store.get(conflictId);
    request.onsuccess = () => { if ((request.result as SyncConflict | undefined)?.user_id === userId) store.delete(conflictId); resolve(); };
  }, CONFLICTS),
  async discardFailedChain(userId, taskId, itemId, projectId, serverState) {
    const db = await openDatabase(parent);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = operationTransaction(db, [OUTBOX, STORE], 'readwrite', parent);
        const outbox = tx.objectStore(OUTBOX), cache = tx.objectStore(STORE);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        const chainRequest = outbox.index('by_user_task').getAll([userId, taskId]);
        chainRequest.onsuccess = () => {
          const chain = (chainRequest.result as OfflineOperation[]).filter((row) => row.task_item_id === itemId);
          if (!chain.some((row) => row.status === 'failed')) { tx.abort(); return; }
          const entriesRequest = cache.getAll();
          entriesRequest.onsuccess = () => {
            try {
              const before = (entriesRequest.result as CacheEntry[]).filter((entry) => entry.user_id === userId);
              const after = applyPullToEntries(before, [{ cursor: 0, task_id: taskId, task_item_id: itemId,
                change_type: serverState ? 'upsert' : 'delete', item: serverState }], projectId);
              for (const entry of after) cache.put(entry, entryKey(userId, entry.key));
              for (const entry of before) if (!after.some((row) => row.key === entry.key)) cache.delete(entryKey(userId, entry.key));
              for (const row of chain) outbox.delete(row.sequence);
            } catch { tx.abort(); }
          };
        };
      });
    } finally { db.close(); }
  },
  initializePullCursor: (userId, cursor) => transact<boolean>('readwrite', (store, resolve) => {
    const key = entryKey(userId, pullKey);
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result) { resolve(false); return; }
      store.put({ user_id: userId, key: pullKey, data: JSON.stringify(cursor),
        last_synced_at: new Date().toISOString(), schema_version: 1 } satisfies CacheEntry, key);
      resolve(true);
    };
  }),
  async applyPullPage(userId, afterCursor, nextCursor, changes) {
    const db = await openDatabase(parent);
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const tx = operationTransaction(db, STORE, 'readwrite', parent);
        const cache = tx.objectStore(STORE);
        let applied = false;
        tx.oncomplete = () => resolve(applied); tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed')); tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        const cursorRequest = cache.get(entryKey(userId, pullKey));
        cursorRequest.onsuccess = () => {
          const current = cursorRequest.result as CacheEntry | undefined;
          if (Number(JSON.parse(current?.data ?? '0')) !== afterCursor) return;
          const entriesRequest = cache.getAll();
          entriesRequest.onsuccess = () => {
            try {
              const entries = (entriesRequest.result as CacheEntry[]).filter((entry) => entry.user_id === userId);
              let next = entries;
              for (const change of changes) {
                const task = entries.find((entry) => entry.key === `task:${change.task_id}`);
                const projectId = task ? (JSON.parse(task.data) as { project_id?: string }).project_id : undefined;
                next = applyPullToEntries(next, [change], projectId);
              }
              for (const entry of next) cache.put(entry, entryKey(userId, entry.key));
              for (const entry of entries) if (!next.some((row) => row.key === entry.key)) cache.delete(entryKey(userId, entry.key));
              cache.put({ user_id: userId, key: pullKey, data: JSON.stringify(nextCursor),
                last_synced_at: new Date().toISOString(), schema_version: 1 } satisfies CacheEntry, entryKey(userId, pullKey));
              applied = true;
            } catch { tx.abort(); }
          };
        };
      });
    } finally { db.close(); }
  },
  async reconcileOperation(userId, operationId, item, activeSnapshot, guards = []) {
    const db = await openDatabase(parent);
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = operationTransaction(db, [OUTBOX, STORE], 'readwrite', parent);
        const outbox = tx.objectStore(OUTBOX);
        const cache = tx.objectStore(STORE);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB reconciliation failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB reconciliation aborted'));
        for (const guard of guards) {
          const request = cache.get(entryKey(userId, guard.key));
          request.onsuccess = () => { if (((request.result as CacheEntry | undefined)?.data ?? null) !== guard.data) tx.abort(); };
        }
        const operationRequest = outbox.index('by_operation_id').get(operationId);
        operationRequest.onsuccess = () => {
          const operation = operationRequest.result as OfflineOperation | undefined;
          if (!operation || operation.user_id !== userId) return;
          if (operation.status !== 'synced_unreconciled' || (item && operation.task_item_id !== item.id)) {
            tx.abort();
            return;
          }
          const keys = reconciledKeys(operation);
          const entries: (CacheEntry | null)[] = Array(keys.length).fill(null);
          let remaining = keys.length;
          keys.forEach((key, index) => {
            const request = cache.get(entryKey(userId, key));
            request.onsuccess = () => {
              entries[index] = (request.result as CacheEntry | undefined) ?? null;
              remaining -= 1;
              if (remaining !== 0) return;
              try {
                const updated = reconcileEntries(entries, operation, item, activeSnapshot);
                updated.forEach((entry, i) => {
                  if (entry) cache.put(entry, entryKey(userId, keys[i]));
                  else cache.delete(entryKey(userId, keys[i]));
                });
                outbox.delete(operation.sequence);
              } catch {
                tx.abort();
              }
            };
          });
        };
      });
    } finally {
      db.close();
    }
  },
};
}
export const localCacheDriver = operationDriver();
