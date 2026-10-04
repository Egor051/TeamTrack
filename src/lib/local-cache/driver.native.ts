import * as SQLite from 'expo-sqlite';
import type { CacheEntry, LocalCacheDriver, OfflineOperation, OfflineOperationInput, SyncConflict } from './types';
import { reconcileEntries, reconciledKeys } from './reconcile';
import { applyPullToEntries, validSyncVersion } from './pull-cache';

const pullKey = 'sync:task-items:cursor';
type Tx = SQLite.SQLiteDatabase;

async function readEntries(tx: Tx, userId: string): Promise<CacheEntry[]> {
  return tx.getAllAsync<CacheEntry>('SELECT user_id, cache_key AS key, data, last_synced_at, schema_version FROM cache_entries WHERE user_id = ?', [userId]);
}

async function writeEntries(tx: Tx, userId: string, before: CacheEntry[], after: CacheEntry[]): Promise<void> {
  const keys = new Set(after.map((entry) => entry.key));
  for (const entry of before) if (!keys.has(entry.key))
    await tx.runAsync('DELETE FROM cache_entries WHERE user_id = ? AND cache_key = ?', [userId, entry.key]);
  for (const entry of after) await tx.runAsync(
    'INSERT OR REPLACE INTO cache_entries (user_id, cache_key, data, last_synced_at, schema_version) VALUES (?, ?, ?, ?, ?)',
    [entry.user_id, entry.key, entry.data, entry.last_synced_at, entry.schema_version]);
}

function decodeConflict(row: { data: string }): SyncConflict { return JSON.parse(row.data) as SyncConflict; }

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
let transactionQueue: Promise<void> = Promise.resolve();

function exclusiveBase(db: SQLite.SQLiteDatabase, action: (tx: SQLite.SQLiteDatabase) => Promise<void>): Promise<void> {
  const task = transactionQueue.then(() => db.withExclusiveTransactionAsync(action));
  transactionQueue = task.catch(() => undefined);
  return task;
}

function database(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = (async () => {
      const db = await SQLite.openDatabaseAsync('tasktrace-local-cache.db');
      const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
      if ((version?.user_version ?? 0) < 1) {
        await db.withExclusiveTransactionAsync(async (tx) => { await tx.execAsync(`CREATE TABLE IF NOT EXISTS cache_entries (
          user_id TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          data TEXT NOT NULL,
          last_synced_at TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          PRIMARY KEY (user_id, cache_key)
        ); PRAGMA user_version = 1;`); });
      }
      if ((version?.user_version ?? 0) < 2) {
        await db.withExclusiveTransactionAsync(async (tx) => { await tx.execAsync(`CREATE TABLE IF NOT EXISTS pending_operations (
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
        PRAGMA user_version = 2;`); });
      }
      if ((version?.user_version ?? 0) < 3) {
        await db.withExclusiveTransactionAsync(async (tx) => { await tx.execAsync(`ALTER TABLE pending_operations ADD COLUMN server_result TEXT;
          ALTER TABLE pending_operations ADD COLUMN last_error TEXT;
          PRAGMA user_version = 3;`); });
      }
      if ((version?.user_version ?? 0) < 4) {
        await db.withExclusiveTransactionAsync(async (tx) => { await tx.execAsync(`ALTER TABLE pending_operations ADD COLUMN expected_version INTEGER;
          ALTER TABLE pending_operations ADD COLUMN depends_on_operation_id TEXT;
          ALTER TABLE pending_operations ADD COLUMN server_version INTEGER;
          CREATE TABLE sync_conflicts (
            conflict_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
            task_item_id TEXT NOT NULL, data TEXT NOT NULL
          );
          CREATE INDEX sync_conflicts_user ON sync_conflicts(user_id, conflict_id);
          PRAGMA user_version = 4;`); });
      }
      if ((version?.user_version ?? 0) < 5) {
        await db.withExclusiveTransactionAsync(async (tx) => {
          await tx.execAsync('ALTER TABLE pending_operations ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1; PRAGMA user_version = 5;');
        });
      }
      return db;
    })().catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

function operationDriver(parent?: AbortSignal): LocalCacheDriver {
  const check = () => { if (parent?.aborted) throw Object.assign(new Error('Operation cancelled'), { name: 'AbortError' }); };
  const exclusive = (db: SQLite.SQLiteDatabase, action: (tx: SQLite.SQLiteDatabase) => Promise<void>) =>
    exclusiveBase(db, async (tx) => { check(); await action(tx); check(); });
  return {
  withOperation: operationDriver,
  async commitCacheBatch(userId, batch, removeKeys = [], guards = []) {
    if (batch.some((entry) => entry.user_id !== userId)) throw new Error('Cache batch user mismatch');
    const db = await database();
    let committed = false;
    await exclusive(db, async (tx) => {
      for (const guard of guards) {
        const row = await tx.getFirstAsync<{ data: string }>('SELECT data FROM cache_entries WHERE user_id = ? AND cache_key = ?', [userId, guard.key]);
        if ((row?.data ?? null) !== guard.data) return;
      }
      for (const key of removeKeys) await tx.runAsync('DELETE FROM cache_entries WHERE user_id = ? AND cache_key = ?', [userId, key]);
      for (const entry of batch) await tx.runAsync(
        'INSERT OR REPLACE INTO cache_entries (user_id, cache_key, data, last_synced_at, schema_version) VALUES (?, ?, ?, ?, ?)',
        [userId, entry.key, entry.data, entry.last_synced_at, entry.schema_version]);
      committed = true;
    });
    return committed;
  },
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
    await exclusive(db, async (tx) => { await tx.runAsync(
      'INSERT OR REPLACE INTO cache_entries (user_id, cache_key, data, last_synced_at, schema_version) VALUES (?, ?, ?, ?, ?)',
      [entry.user_id, entry.key, entry.data, entry.last_synced_at, entry.schema_version],
    ); });
  },
  async putIfUnchanged(entry, expectedData) {
    const db = await database();
    await exclusive(db, async (tx) => {
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
    await exclusive(db, async (tx) => { await tx.runAsync('DELETE FROM cache_entries WHERE user_id = ? AND cache_key = ?', [userId, key]); });
  },
  async listEntries(userId, prefix = '') {
    const db = await database();
    return (await readEntries(db, userId)).filter((entry) => entry.key.startsWith(prefix));
  },
  async enqueue(operation: OfflineOperationInput): Promise<OfflineOperation> {
    const db = await database();
    let saved!: OfflineOperation;
    await exclusive(db, async (tx) => {
      const predecessor = await tx.getFirstAsync<OfflineOperation>(
        'SELECT * FROM pending_operations WHERE user_id = ? AND task_item_id = ? ORDER BY sequence DESC LIMIT 1',
        [operation.user_id, operation.task_item_id]);
      if (predecessor?.status === 'failed' || predecessor?.status === 'conflict')
        throw new Error('Сначала разрешите несинхронизированные изменения пункта.');
      if (predecessor && !validSyncVersion(predecessor.expected_version) && !predecessor.depends_on_operation_id)
        throw new Error('Сначала разрешите несинхронизированные изменения пункта.');
      const entry = await tx.getFirstAsync<CacheEntry>(
        'SELECT user_id, cache_key AS key, data, last_synced_at, schema_version FROM cache_entries WHERE user_id = ? AND cache_key = ?',
        [operation.user_id, `items:${operation.task_id}:active`]);
      const item = entry && (JSON.parse(entry.data) as { id: string; sync_version?: number }[])
        .find((row) => row.id === operation.task_item_id);
      if (!predecessor && !validSyncVersion(item?.sync_version))
        throw new Error('Для офлайн-редактирования сначала синхронизируйте данные при подключении к интернету.');
      const expected = predecessor
        ? (predecessor.status === 'synced_unreconciled' && validSyncVersion(predecessor.server_version)
          ? predecessor.server_version : null)
        : validSyncVersion(operation.expected_version) ? operation.expected_version : item!.sync_version!;
      const dependency = predecessor?.operation_id ?? null;
      const result = await tx.runAsync(
        'INSERT INTO pending_operations (operation_id, user_id, project_id, task_id, task_item_id, type, payload, created_at, status, expected_version, depends_on_operation_id, protocol_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [operation.operation_id, operation.user_id, operation.project_id, operation.task_id, operation.task_item_id,
          operation.type, JSON.stringify(operation.payload), operation.created_at, operation.status, expected, dependency,
          operation.protocol_version ?? 1]);
      saved = { ...operation, sequence: result.lastInsertRowId, expected_version: expected, depends_on_operation_id: dependency };
    });
    return saved;
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
    await exclusive(db, async (tx) => { await tx.runAsync(
      'UPDATE pending_operations SET status = ?, server_result = ?, last_error = ? WHERE user_id = ? AND operation_id = ?',
      [status, result === undefined ? null : JSON.stringify(result), error ?? null, userId, operationId],
    ); });
  },
  async acknowledgeOperation(userId, operationId, version, conflictId, item) {
    const db = await database();
    await exclusive(db, async (tx) => {
      await tx.runAsync('UPDATE pending_operations SET status = ?, server_version = ? WHERE user_id = ? AND operation_id = ?',
        ['synced_unreconciled', version, userId, operationId]);
      await tx.runAsync('UPDATE pending_operations SET expected_version = ?, depends_on_operation_id = NULL WHERE user_id = ? AND depends_on_operation_id = ?',
        [version, userId, operationId]);
      if (conflictId && item) {
        const row = await tx.getFirstAsync<{ data: string }>(
          'SELECT data FROM sync_conflicts WHERE conflict_id = ? AND user_id = ?', [conflictId, userId]);
        if (row) {
          const conflict = decodeConflict(row);
          if (conflict.operation_ids.includes(operationId))
            await tx.runAsync('UPDATE sync_conflicts SET data = ? WHERE conflict_id = ? AND user_id = ?',
              [JSON.stringify({ ...conflict, server_state: item, server_version: version,
                updated_at: new Date().toISOString() }), conflictId, userId]);
        }
      }
    });
  },
  async listConflicts(userId) {
    const db = await database();
    const rows = await db.getAllAsync<{ data: string }>(
      'SELECT data FROM sync_conflicts WHERE user_id = ? ORDER BY conflict_id', [userId]);
    return rows.map(decodeConflict).filter((row) => row.user_id === userId && row.status === 'unresolved')
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.conflict_id.localeCompare(b.conflict_id));
  },
  async createConflict(conflict) {
    const db = await database();
    await exclusive(db, async (tx) => {
      const previous = await tx.getFirstAsync<{ data: string }>('SELECT data FROM sync_conflicts WHERE conflict_id = ?', [conflict.conflict_id]);
      const old = previous ? decodeConflict(previous) : null;
      if (old && old.user_id !== conflict.user_id) throw new Error('Conflict ownership mismatch');
      await tx.runAsync('INSERT OR REPLACE INTO sync_conflicts(conflict_id, user_id, task_item_id, data) VALUES (?, ?, ?, ?)',
        [conflict.conflict_id, conflict.user_id, conflict.task_item_id,
          JSON.stringify({ ...conflict, created_at: old?.created_at ?? conflict.created_at })]);
      for (const operationId of conflict.operation_ids)
        await tx.runAsync('UPDATE pending_operations SET status = ? WHERE user_id = ? AND task_item_id = ? AND operation_id = ?',
          ['conflict', conflict.user_id, conflict.task_item_id, operationId]);
    });
  },
  async rebaseConflict(userId, conflictId, version) {
    const db = await database();
    await exclusive(db, async (tx) => {
      const row = await tx.getFirstAsync<{ data: string }>('SELECT data FROM sync_conflicts WHERE conflict_id = ? AND user_id = ?', [conflictId, userId]);
      if (!row) throw new Error('Conflict unavailable');
      const conflict = decodeConflict(row);
      const chain = await tx.getAllAsync<OfflineOperation>(
        'SELECT operation_id, status, sequence FROM pending_operations WHERE user_id = ? AND task_item_id = ? ORDER BY sequence',
        [userId, conflict.task_item_id]);
      const first = chain.find((operation) => conflict.operation_ids.includes(operation.operation_id)
        && operation.status !== 'synced_unreconciled');
      for (const operation of chain) {
        if (!conflict.operation_ids.includes(operation.operation_id) || operation.status === 'synced_unreconciled') continue;
        await tx.runAsync('UPDATE pending_operations SET expected_version = CASE WHEN operation_id = ? THEN ? ELSE expected_version END, status = ? WHERE user_id = ? AND operation_id = ?',
          [first?.operation_id ?? '', version, 'pending', userId, operation.operation_id]);
      }
    });
  },
  async resolveServerConflict(userId, conflictId) {
    const db = await database();
    await exclusive(db, async (tx) => {
      const row = await tx.getFirstAsync<{ data: string }>('SELECT data FROM sync_conflicts WHERE conflict_id = ? AND user_id = ?', [conflictId, userId]);
      if (!row) throw new Error('Conflict unavailable');
      const conflict = decodeConflict(row);
      const before = await readEntries(tx, userId);
      const after = applyPullToEntries(before, [{ cursor: 0, task_id: conflict.task_id,
        task_item_id: conflict.task_item_id, change_type: conflict.server_state ? 'upsert' : 'delete',
        item: conflict.server_state }], conflict.project_id);
      await writeEntries(tx, userId, before, after);
      for (const operationId of conflict.operation_ids)
        await tx.runAsync('DELETE FROM pending_operations WHERE user_id = ? AND task_item_id = ? AND operation_id = ?',
          [userId, conflict.task_item_id, operationId]);
      await tx.runAsync('DELETE FROM sync_conflicts WHERE conflict_id = ? AND user_id = ?', [conflictId, userId]);
    });
  },
  async finishMineConflict(userId, conflictId) {
    const db = await database();
    await exclusive(db, async (tx) => { await tx.runAsync('DELETE FROM sync_conflicts WHERE conflict_id = ? AND user_id = ?', [conflictId, userId]); });
  },
  async discardFailedChain(userId, taskId, itemId, projectId, serverState) {
    const db = await database();
    await exclusive(db, async (tx) => {
      const chain = await tx.getAllAsync<{ status: string }>(
        'SELECT status FROM pending_operations WHERE user_id = ? AND task_id = ? AND task_item_id = ?',
        [userId, taskId, itemId]);
      if (!chain.some((row) => row.status === 'failed')) throw new Error('Failed operation unavailable');
      const before = await readEntries(tx, userId);
      const after = applyPullToEntries(before, [{ cursor: 0, task_id: taskId, task_item_id: itemId,
        change_type: serverState ? 'upsert' : 'delete', item: serverState }], projectId);
      await writeEntries(tx, userId, before, after);
      await tx.runAsync('DELETE FROM pending_operations WHERE user_id = ? AND task_id = ? AND task_item_id = ?',
        [userId, taskId, itemId]);
    });
  },
  async initializePullCursor(userId, cursor) {
    const db = await database();
    let created = false;
    await exclusive(db, async (tx) => {
      const current = await tx.getFirstAsync('SELECT 1 FROM cache_entries WHERE user_id = ? AND cache_key = ?', [userId, pullKey]);
      if (current) return;
      await tx.runAsync('INSERT INTO cache_entries VALUES (?, ?, ?, ?, ?)',
        [userId, pullKey, JSON.stringify(cursor), new Date().toISOString(), 1]);
      created = true;
    });
    return created;
  },
  async applyPullPage(userId, afterCursor, nextCursor, changes) {
    const db = await database();
    let applied = false;
    await exclusive(db, async (tx) => {
      const current = await tx.getFirstAsync<{ data: string }>(
        'SELECT data FROM cache_entries WHERE user_id = ? AND cache_key = ?', [userId, pullKey]);
      if (Number(JSON.parse(current?.data ?? '0')) !== afterCursor) return;
      const before = await readEntries(tx, userId);
      let after = before;
      for (const change of changes) {
        const task = before.find((entry) => entry.key === `task:${change.task_id}`);
        const projectId = task ? (JSON.parse(task.data) as { project_id?: string }).project_id : undefined;
        after = applyPullToEntries(after, [change], projectId);
      }
      after = after.filter((entry) => entry.key !== pullKey);
      after.push({ user_id: userId, key: pullKey, data: JSON.stringify(nextCursor),
        last_synced_at: new Date().toISOString(), schema_version: 1 });
      await writeEntries(tx, userId, before, after);
      applied = true;
    });
    return applied;
  },
  async reconcileOperation(userId, operationId, item, activeSnapshot) {
    const db = await database();
    await exclusive(db, async (tx) => {
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
}
export const localCacheDriver = operationDriver();
