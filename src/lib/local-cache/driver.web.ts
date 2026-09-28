import type { CacheEntry, LocalCacheDriver } from './types';

const DB_NAME = 'tasktrace-local-cache';
const STORE = 'entries';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB upgrade is blocked'));
  });
}

function entryKey(userId: string, key: string): string {
  return `${userId}:${key}`;
}

async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, resolve: (value: T) => void) => void): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      action(tx.objectStore(STORE), (result) => { value = result; });
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
};
