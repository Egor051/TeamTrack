import * as SQLite from 'expo-sqlite';
import type { CacheEntry, LocalCacheDriver, OfflineOperation, OfflineOperationInput } from './types';
import { reconcileEntries, reconciledKeys } from './reconcile';

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
      if ((version?.user_version ?? 0) < 2) {
        await db.execAsync(`CREATE TABLE IF NOT EXISTS pending_operations (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          operation_id TEXT NOT NULL UNIQUE,
          user_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          task_item_id TEXT NOT NULL,
          type TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          status TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS pending_operations_user_task ON pending_operations (user_id, task_id, sequence);
        PRAGMA user_version = 2;`);
      }
      if ((version?.user_version ?? 0) < 3) {
        await db.execAsync(`ALTER TABLE pending_operations ADD COLUMN server_result TEXT;
          ALTER TABLE pending_operations ADD COLUMN last_error TEXT;
          PRAGMA user_version = 3;`);
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
  async putIfUnchanged(entry, expectedData) {
    const db = await database();
    await db.withExclusiveTransactionAsync(async (tx) => {
      const current = await tx.getFirstAsync<{ data: string }>(
        'SELECT data FROM cache_entries WHERE user_id = ? AND cache_key = ?', [entry.user_id, entry.key],
      );
      if ((current?.data ?? null) !== expectedData) return;
      await tx.runAsync('INSERT OR REPLACE INTO cache_entries (user_id, cache_key, data, last_synced_at, schema_version) VALUES (?, ?, ?, ?, ?)',
        [entry.user_id, entry.key, entry.data, entry.last_synced_at, entry.schema_version]);
    });
  },
  async remove(userId, key) {
    const db = await database();
    await db.runAsync('DELETE FROM cache_entries WHERE user_id = ? AND cache_key = ?', [userId, key]);
  },
  async enqueue(operation: OfflineOperationInput): Promise<OfflineOperation> {
    const db = await database();
    const result = await db.runAsync(
      'INSERT INTO pending_operations (operation_id, user_id, project_id, task_id, task_item_id, type, payload, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [operation.operation_id, operation.user_id, operation.project_id, operation.task_id, operation.task_item_id, operation.type, JSON.stringify(operation.payload), operation.created_at, operation.status],
    );
    return { ...operation, sequence: result.lastInsertRowId };
  },
  async listPending(userId, taskId): Promise<OfflineOperation[]> {
    const db = await database();
    const rows = await db.getAllAsync<Omit<OfflineOperation, 'payload'> & { payload: string }>(
      taskId
        ? 'SELECT * FROM pending_operations WHERE user_id = ? AND task_id = ? ORDER BY sequence'
        : 'SELECT * FROM pending_operations WHERE user_id = ? ORDER BY sequence',
      taskId ? [userId, taskId] : [userId],
    );
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) as OfflineOperation['payload'],
      server_result: row.server_result == null ? undefined : JSON.parse(row.server_result as string) as OfflineOperation['server_result'] }));
  },
  async markOperation(userId, operationId, status, result, error) {
    const db = await database();
    await db.runAsync(
      'UPDATE pending_operations SET status = ?, server_result = ?, last_error = ? WHERE user_id = ? AND operation_id = ?',
      [status, result === undefined ? null : JSON.stringify(result), error ?? null, userId, operationId],
    );
  },
  async reconcileOperation(userId, operationId, item, activeSnapshot) {
    const db = await database();
    await db.withExclusiveTransactionAsync(async (tx) => {
      const row = await tx.getFirstAsync<Omit<OfflineOperation, 'payload' | 'server_result'> & { payload: string; server_result: string | null }>(
        'SELECT * FROM pending_operations WHERE user_id = ? AND operation_id = ?', [userId, operationId],
      );
      if (!row) return;
      const operation: OfflineOperation = { ...row, payload: JSON.parse(row.payload) as OfflineOperation['payload'] };
      if (operation.status !== 'synced_unreconciled' || operation.task_item_id !== item.id) throw new Error('Invalid reconciliation');
      const keys = reconciledKeys(operation);
      const entries = await Promise.all(keys.map(async (key) =>
        await tx.getFirstAsync<CacheEntry>(
          'SELECT user_id, cache_key AS key, data, last_synced_at, schema_version FROM cache_entries WHERE user_id = ? AND cache_key = ?',
          [userId, key],
        )));
      const updated = reconcileEntries(entries, operation, item, activeSnapshot);
      for (let i = 0; i < keys.length; i += 1) {
        if (updated[i]) {
          const entry = updated[i]!;
          await tx.runAsync('INSERT OR REPLACE INTO cache_entries (user_id, cache_key, data, last_synced_at, schema_version) VALUES (?, ?, ?, ?, ?)',
            [entry.user_id, entry.key, entry.data, entry.last_synced_at, entry.schema_version]);
        } else {
          await tx.runAsync('DELETE FROM cache_entries WHERE user_id = ? AND cache_key = ?', [userId, keys[i]]);
        }
      }
      await tx.runAsync('DELETE FROM pending_operations WHERE user_id = ? AND operation_id = ?', [userId, operationId]);
    });
  },
};
