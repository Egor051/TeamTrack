import * as SQLite from 'expo-sqlite';
import type { CacheEntry, LocalCacheDriver } from './types';

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

function database(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = (async () => {
      const db = await SQLite.openDatabaseAsync('tasktrace-local-cache.db');
      const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      if ((version?.user_version ?? 0) < 1) {
        await db.execAsync(`CREATE TABLE IF NOT EXISTS cache_entries (
          user_id TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          data TEXT NOT NULL,
          last_synced_at TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          PRIMARY KEY (user_id, cache_key)
        ); PRAGMA user_version = 1;`);
      }
      return db;
    })().catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

export const localCacheDriver: LocalCacheDriver = {
  async get(userId, key) {
    const db = await database();
    const row = await db.getFirstAsync<CacheEntry>(
      'SELECT user_id, cache_key AS key, data, last_synced_at, schema_version FROM cache_entries WHERE user_id = ? AND cache_key = ?',
      [userId, key],
    );
    return row ?? null;
  },
  async put(entry) {
    const db = await database();
    await db.runAsync(
      'INSERT OR REPLACE INTO cache_entries (user_id, cache_key, data, last_synced_at, schema_version) VALUES (?, ?, ?, ?, ?)',
      [entry.user_id, entry.key, entry.data, entry.last_synced_at, entry.schema_version],
    );
  },
  async remove(userId, key) {
    const db = await database();
    await db.runAsync('DELETE FROM cache_entries WHERE user_id = ? AND cache_key = ?', [userId, key]);
  },
};
