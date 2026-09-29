import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheEntry, OfflineOperationInput } from '@/lib/local-cache/types';

const state = vi.hoisted(() => ({ database: null as DatabaseSync | null }));

vi.mock('expo-sqlite', () => ({
  openDatabaseAsync: async () => {
    const db = state.database!;
    return {
      getFirstAsync: async <T>(sql: string, params: (string | number | null)[] = []) => db.prepare(sql).get(...params) as T | null,
      getAllAsync: async <T>(sql: string, params: (string | number | null)[] = []) => db.prepare(sql).all(...params) as T[],
      runAsync: async (sql: string, params: (string | number | null)[] = []) => {
        const result = db.prepare(sql).run(...params);
        return { lastInsertRowId: Number(result.lastInsertRowid) };
      },
      execAsync: async (sql: string) => { db.exec(sql); },
      withExclusiveTransactionAsync: async (callback: (tx: unknown) => Promise<void>) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          await callback({
            getFirstAsync: async <T>(sql: string, params: (string | number | null)[] = []) => db.prepare(sql).get(...params) as T | null,
            runAsync: async (sql: string, params: (string | number | null)[] = []) => db.prepare(sql).run(...params),
          });
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    };
  },
}));

function input(id: string): OfflineOperationInput {
  return { operation_id: id, user_id: 'user-a', project_id: 'project-1', task_id: 'task-1', task_item_id: 'item-1',
    type: 'set_task_item_state', payload: { completed: true }, created_at: '2026-09-28T00:00:00Z', status: 'pending' };
}

beforeEach(() => {
  state.database?.close();
  state.database = new DatabaseSync(':memory:');
  vi.resetModules();
});

describe('SQLite outbox migration', () => {
  it('upgrades a version 1 database and preserves confirmed cache', async () => {
    const db = state.database!;
    db.exec(`CREATE TABLE cache_entries (user_id TEXT NOT NULL, cache_key TEXT NOT NULL, data TEXT NOT NULL,
      last_synced_at TEXT NOT NULL, schema_version INTEGER NOT NULL, PRIMARY KEY (user_id, cache_key)); PRAGMA user_version = 1;`);
    const entry: CacheEntry = { user_id: 'user-a', key: 'items:task-1:active', data: '[{"percentage":20}]', last_synced_at: '2026-09-28', schema_version: 1 };
    db.prepare('INSERT INTO cache_entries VALUES (?, ?, ?, ?, ?)').run(entry.user_id, entry.key, entry.data, entry.last_synced_at, entry.schema_version);
    const { localCacheDriver } = await import('@/lib/local-cache/driver.native');
    expect(await localCacheDriver.get('user-a', entry.key)).toEqual(entry);
    expect(await localCacheDriver.listPending('user-a')).toEqual([]);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
  });

  it('keeps operations after module reinitialization in SQLite order', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.native');
    const [first, second] = await Promise.all([localCacheDriver.enqueue(input('one')), localCacheDriver.enqueue(input('two'))]);
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    vi.resetModules();
    const reopened = (await import('@/lib/local-cache/driver.native')).localCacheDriver;
    expect((await reopened.listPending('user-a', 'task-1')).map((op) => op.operation_id)).toEqual(['one', 'two']);
    expect(await reopened.listPending('user-b')).toEqual([]);
  });

  it('upgrades Phase 3 operations and atomically reconciles a confirmed item', async () => {
    const db = state.database!;
    db.exec(`CREATE TABLE cache_entries (user_id TEXT NOT NULL, cache_key TEXT NOT NULL, data TEXT NOT NULL,
      last_synced_at TEXT NOT NULL, schema_version INTEGER NOT NULL, PRIMARY KEY (user_id, cache_key));
      CREATE TABLE pending_operations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT NOT NULL, task_item_id TEXT NOT NULL,
      type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL);
      CREATE INDEX pending_operations_user_task ON pending_operations (user_id, task_id, sequence);
      PRAGMA user_version = 2;`);
    db.prepare('INSERT INTO pending_operations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(8, 'phase-3-id', 'user-a', 'project-1', 'task-1', 'item-1', 'set_task_item_state', '{"completed":true}', '2026-09-28', 'pending');
    const { localCacheDriver } = await import('@/lib/local-cache/driver.native');
    expect(await localCacheDriver.listPending('user-a')).toMatchObject([{ sequence: 8, operation_id: 'phase-3-id' }]);
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([{ id: 'item-1', percentage: 20, is_completed: false, comment: null }]),
      last_synced_at: '2026-09-28', schema_version: 1 });
    await localCacheDriver.markOperation('user-a', 'phase-3-id', 'synced_unreconciled', true);
    const confirmed = { id: 'item-1', percentage: 100, is_completed: true, comment: null };
    await localCacheDriver.reconcileOperation('user-a', 'phase-3-id', confirmed, [confirmed]);
    expect(await localCacheDriver.listPending('user-a')).toEqual([]);
    expect((await localCacheDriver.get('user-a', 'items:task-1:active'))?.data).toContain('"percentage":100');
  });
});
