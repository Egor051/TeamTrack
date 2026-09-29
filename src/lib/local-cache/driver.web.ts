import type { CacheEntry, LocalCacheDriver, OfflineOperation, OfflineOperationInput } from './types';
import { reconcileEntries, reconciledKeys } from './reconcile';

const DB_NAME = 'tasktrace-local-cache';
const STORE = 'entries';
const OUTBOX = 'pending_operations';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(OUTBOX)) {
        const outbox = db.createObjectStore(OUTBOX, { keyPath: 'sequence', autoIncrement: true });
        outbox.createIndex('by_operation_id', 'operation_id', { unique: true });
        outbox.createIndex('by_user', 'user_id');
        outbox.createIndex('by_user_task', ['user_id', 'task_id']);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked'));
  });
}

function entryKey(userId: string, key: string): string {
  return `${userId}:${key}`;
}

async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, resolve: (value: T) => void) => void, storeName = STORE): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = (event) => reject((event.target as IDBRequest).error ?? tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      action(tx.objectStore(storeName), (result) => { value = result; });
    });
  } finally {
    db.close();
  }
}

export const localCacheDriver: LocalCacheDriver = {
  get: (userId, key) => transact<CacheEntry | null>('readonly', (store, resolve) => {
    const request = store.get(entryKey(userId, key));
    request.onsuccess = () => resolve((request.result as CacheEntry | undefined) ?? null);
  }),
  put: (entry) => transact<void>('readwrite', (store, resolve) => {
    store.put(entry, entryKey(entry.user_id, entry.key));
    resolve();
  }),
  putIfUnchanged: (entry, expectedData) => transact<void>('readwrite', (store, resolve) => {
    const key = entryKey(entry.user_id, entry.key);
    const request = store.get(key);
    request.onsuccess = () => {
      if (((request.result as CacheEntry | undefined)?.data ?? null) === expectedData) store.put(entry, key);
      resolve();
    };
  }),
  remove: (userId, key) => transact<void>('readwrite', (store, resolve) => {
    store.delete(entryKey(userId, key));
    resolve();
  }),
  enqueue: (operation: OfflineOperationInput) => transact<OfflineOperation>('readwrite', (store, resolve) => {
    // The auto-increment key is allocated inside the IndexedDB write transaction.
    // Concurrent tabs cannot allocate the same sequence or overwrite one another.
    const request = store.add(operation);
    request.onsuccess = () => {
      const saved = { ...operation, sequence: Number(request.result) };
      store.put(saved);
      resolve(saved);
    };
  }, OUTBOX),
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
  async reconcileOperation(userId, operationId, item, activeSnapshot) {
    const db = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction([OUTBOX, STORE], 'readwrite');
        const outbox = tx.objectStore(OUTBOX);
        const cache = tx.objectStore(STORE);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB reconciliation failed'));
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB reconciliation aborted'));
        const operationRequest = outbox.index('by_operation_id').get(operationId);
        operationRequest.onsuccess = () => {
          const operation = operationRequest.result as OfflineOperation | undefined;
          if (!operation || operation.user_id !== userId) return;
          if (operation.status !== 'synced_unreconciled' || operation.task_item_id !== item.id) {
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
