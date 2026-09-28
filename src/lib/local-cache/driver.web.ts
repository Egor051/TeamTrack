import type { CacheEntry, LocalCacheDriver, OfflineOperation, OfflineOperationInput } from './types';

const DB_NAME = 'tasktrace-local-cache';
const STORE = 'entries';
const OUTBOX = 'pending_operations';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
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
};
