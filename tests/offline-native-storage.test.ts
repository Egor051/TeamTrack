import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheEntry, OfflineOperationInput, SyncConflict } from '@/lib/local-cache/types';

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
            execAsync: async (sql: string) => { db.exec(sql); },
            getFirstAsync: async <T>(sql: string, params: (string | number | null)[] = []) => db.prepare(sql).get(...params) as T | null,
            getAllAsync: async <T>(sql: string, params: (string | number | null)[] = []) => db.prepare(sql).all(...params) as T[],
            runAsync: async (sql: string, params: (string | number | null)[] = []) => {
              const result = db.prepare(sql).run(...params);
              return { lastInsertRowId: Number(result.lastInsertRowid) };
            },
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
  it('rolls back a queued write when its operation was superseded', async () => {
    const { localCacheDriver: driver } = await import('@/lib/local-cache/driver.native');
    await driver.get('user-a', 'initialize');
    const controller = new AbortController(); const scoped = driver.withOperation!(controller.signal);
    const late = scoped.put({ user_id: 'user-a', key: 'late', data: '[1]', last_synced_at: '', schema_version: 1 });
    controller.abort(); await expect(late).rejects.toMatchObject({ name: 'AbortError' });
    expect(await driver.get('user-a', 'late')).toBeNull();
  });
  it('persists conflict and cursor through module restart with account isolation', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.native');
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([{ id: 'item-1', percentage: 20, is_completed: false, comment: null, sync_version: 10 }]),
      last_synced_at: '2026-09-28', schema_version: 1 });
    const saved = await localCacheDriver.enqueue(input('native-conflict'));
    const server = { id: 'item-1', percentage: 100, is_completed: true, comment: null, sync_version: 11 };
    const conflict: SyncConflict = { conflict_id: `user-a:item-1:${saved.operation_id}`, user_id: 'user-a',
      project_id: 'project-1', task_id: 'task-1', task_item_id: 'item-1', operation_ids: [saved.operation_id],
      local_effective_state: { ...server, percentage: 20, is_completed: false }, server_state: server,
      server_version: 11, conflicting_fields: ['progress'], project_name: 'Project', task_name: 'Task', item_name: 'Item',
      created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', status: 'unresolved' };
    await localCacheDriver.createConflict(conflict);
    expect(await localCacheDriver.initializePullCursor('user-a', 5)).toBe(true);
    expect(await localCacheDriver.applyPullPage('user-a', 5, 6, [{ cursor: 6, task_id: 'task-1',
      task_item_id: 'item-1', change_type: 'upsert', item: server }])).toBe(true);
    vi.resetModules();
    const reopened = (await import('@/lib/local-cache/driver.native')).localCacheDriver;
    expect(await reopened.listConflicts('user-a')).toEqual([conflict]);
    expect(await reopened.listConflicts('user-b')).toEqual([]);
    expect((await reopened.get('user-a', 'sync:task-items:cursor'))?.data).toBe('6');
    expect((await reopened.listPending('user-a'))[0].expected_version).toBe(10);
    await reopened.resolveServerConflict('user-a', conflict.conflict_id);
    expect(await reopened.listConflicts('user-a')).toEqual([]);
    expect(await reopened.listPending('user-a')).toEqual([]);
    expect((await reopened.get('user-a', 'items:task-1:active'))?.data).toContain('"percentage":100');
  });

  it('refuses an unversioned confirmed cache for new offline writes', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.native');
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([{ id: 'item-1', percentage: 20 }]), last_synced_at: '2026-09-28', schema_version: 1 });
    await expect(localCacheDriver.enqueue(input('unknown-base'))).rejects.toThrow('синхронизируйте');
    expect(await localCacheDriver.listPending('user-a')).toEqual([]);
  });
  it('upgrades a version 1 database and preserves confirmed cache', async () => {
    const db = state.database!;
    db.exec(`CREATE TABLE cache_entries (user_id TEXT NOT NULL, cache_key TEXT NOT NULL, data TEXT NOT NULL,
      last_synced_at TEXT NOT NULL, schema_version INTEGER NOT NULL, PRIMARY KEY (user_id, cache_key)); PRAGMA user_version = 1;`);
    const entry: CacheEntry = { user_id: 'user-a', key: 'items:task-1:active', data: '[{"percentage":20}]', last_synced_at: '2026-09-28', schema_version: 1 };
    db.prepare('INSERT INTO cache_entries VALUES (?, ?, ?, ?, ?)').run(entry.user_id, entry.key, entry.data, entry.last_synced_at, entry.schema_version);
    const { localCacheDriver } = await import('@/lib/local-cache/driver.native');
    expect(await localCacheDriver.get('user-a', entry.key)).toEqual(entry);
    expect(await localCacheDriver.listPending('user-a')).toEqual([]);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(5);
  });

  it('rolls back a failed SQLite migration and preserves existing cache', async () => {
    const db = state.database!;
    db.exec(`CREATE TABLE cache_entries (user_id TEXT NOT NULL, cache_key TEXT NOT NULL, data TEXT NOT NULL,
      last_synced_at TEXT NOT NULL, schema_version INTEGER NOT NULL, PRIMARY KEY (user_id, cache_key));
      CREATE TABLE pending_operations (sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL);
      CREATE TABLE sync_conflicts (placeholder INTEGER);
      PRAGMA user_version = 3;`);
    db.prepare('INSERT INTO cache_entries VALUES (?, ?, ?, ?, ?)')
      .run('user-a', 'items:task-1:active', '[{"id":"item-1"}]', '2026-09-28', 1);
    const { localCacheDriver } = await import('@/lib/local-cache/driver.native');
    await expect(localCacheDriver.get('user-a', 'items:task-1:active')).rejects.toThrow();
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3);
    expect(db.prepare('SELECT data FROM cache_entries WHERE user_id = ?').get('user-a')).toEqual({ data: '[{"id":"item-1"}]' });
    expect((db.prepare('PRAGMA table_info(pending_operations)').all() as { name: string }[])
      .some((column) => column.name === 'expected_version')).toBe(false);
  });

  it('keeps operations after module reinitialization in SQLite order', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.native');
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([{ id: 'item-1', sync_version: 10 }]), last_synced_at: '2026-09-28', schema_version: 1 });
    const [first, second] = await Promise.all([localCacheDriver.enqueue(input('one')), localCacheDriver.enqueue(input('two'))]);
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    vi.resetModules();
    const reopened = (await import('@/lib/local-cache/driver.native')).localCacheDriver;
    expect((await reopened.listPending('user-a', 'task-1')).map((op) => op.operation_id)).toEqual(['one', 'two']);
    expect(await reopened.listPending('user-b')).toEqual([]);
    await reopened.acknowledgeOperation('user-a', first.operation_id, 11);
    expect((await reopened.listPending('user-a', 'task-1'))[1]).toMatchObject({
      expected_version: 11, depends_on_operation_id: null,
    });
  });

  it('atomically discards a failed chain and restores confirmed data', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.native');
    const confirmed = { id: 'item-1', task_id: 'task-1', sync_version: 10,
      percentage: 20, is_completed: false, comment: null, is_archived: false };
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([confirmed]), last_synced_at: '2026-09-28', schema_version: 1 });
    const first = await localCacheDriver.enqueue(input('native-discard-first'));
    await localCacheDriver.enqueue(input('native-discard-second'));
    await localCacheDriver.markOperation('user-a', first.operation_id, 'failed', undefined, 'Rejected');
    await localCacheDriver.discardFailedChain('user-a', 'task-1', 'item-1', 'project-1', confirmed);
    expect(await localCacheDriver.listPending('user-a')).toEqual([]);
    expect(JSON.parse((await localCacheDriver.get('user-a', 'items:task-1:active'))!.data)).toEqual([confirmed]);
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
