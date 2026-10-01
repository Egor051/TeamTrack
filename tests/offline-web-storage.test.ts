import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheEntry, OfflineOperationInput, SyncConflict } from '@/lib/local-cache/types';

const name = 'tasktrace-local-cache';

function requestDone<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function deleteDatabase(): Promise<void> {
  await requestDone(indexedDB.deleteDatabase(name));
}

function input(id: string, userId = 'user-a'): OfflineOperationInput {
  return { operation_id: id, user_id: userId, project_id: 'project-1', task_id: 'task-1',
    task_item_id: 'item-1', type: 'set_task_item_percentage', payload: { percentage: 70 },
    created_at: new Date().toISOString(), status: 'pending' };
}

beforeEach(async () => {
  await deleteDatabase();
  vi.resetModules();
});

describe('IndexedDB outbox', () => {
  it('commits snapshot and resume metadata atomically, rejects a stale lease and never changes the outbox', async () => {
    const { localCacheDriver: driver } = await import('@/lib/local-cache/driver.web');
    const entry = (key: string, data: string): CacheEntry => ({ user_id: 'user-a', key, data, last_synced_at: '2026-10-01', schema_version: 1 });
    await driver.put(entry('items:task-1:active', '[{"id":"item-1","sync_version":10}]'));
    await driver.enqueue(input('retained-outbox'));
    expect(await driver.commitCacheBatch('user-a', [entry('bootstrap:metadata', '"leader-a"'), entry('bootstrap:batch:items:rev:0', '[1]')], [], [{ key: 'bootstrap:metadata', data: null }])).toBe(true);
    expect(await driver.commitCacheBatch('user-a', [entry('bootstrap:metadata', '"leader-b"'), entry('bootstrap:batch:items:rev:500', '[2]')], [], [{ key: 'bootstrap:metadata', data: null }])).toBe(false);
    expect(await driver.get('user-a', 'bootstrap:batch:items:rev:500')).toBeNull();
    expect((await driver.get('user-a', 'bootstrap:metadata'))?.data).toBe('"leader-a"');
    expect((await driver.listPending('user-a'))[0].operation_id).toBe('retained-outbox');
    await expect(driver.commitCacheBatch('user-a', [{ ...entry('wrong', 'true'), user_id: 'user-b' }])).rejects.toThrow('mismatch');
    expect(await driver.get('user-b', 'bootstrap:metadata')).toBeNull();
  });
  it('rejects an offline edit when the confirmed item has no server version', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.web');
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([{ id: 'item-1', percentage: 20 }]), last_synced_at: '2026-09-28', schema_version: 1 });
    await expect(localCacheDriver.enqueue(input('unversioned'))).rejects.toThrow('синхронизируйте');
    expect(await localCacheDriver.listPending('user-a')).toEqual([]);
  });

  it('preserves the historical base and advances a dependent edit after ACK and reload', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.web');
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([{ id: 'item-1', sync_version: 10 }]), last_synced_at: '2026-09-28', schema_version: 1 });
    const first = await localCacheDriver.enqueue(input('first'));
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([{ id: 'item-1', sync_version: 11 }]), last_synced_at: '2026-09-28', schema_version: 1 });
    const second = await localCacheDriver.enqueue(input('second'));
    expect(first.expected_version).toBe(10);
    expect(second.expected_version).toBeNull();
    expect(second.depends_on_operation_id).toBe(first.operation_id);
    await localCacheDriver.acknowledgeOperation('user-a', first.operation_id, 12);
    vi.resetModules();
    const restarted = (await import('@/lib/local-cache/driver.web')).localCacheDriver;
    expect((await restarted.listPending('user-a')).map((row) => row.expected_version)).toEqual([10, 12]);
    expect((await restarted.listPending('user-a'))[1].depends_on_operation_id).toBeNull();
  });

  it('atomically discards a failed item chain and restores confirmed data', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.web');
    const confirmed = { id: 'item-1', task_id: 'task-1', sync_version: 10,
      percentage: 20, is_completed: false, comment: null, is_archived: false };
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([confirmed]), last_synced_at: '2026-09-28', schema_version: 1 });
    const first = await localCacheDriver.enqueue(input('discard-first'));
    await localCacheDriver.enqueue(input('discard-second'));
    await localCacheDriver.markOperation('user-a', first.operation_id, 'failed', undefined, 'Rejected');
    await localCacheDriver.discardFailedChain('user-a', 'task-1', 'item-1', 'project-1', confirmed);
    expect(await localCacheDriver.listPending('user-a')).toEqual([]);
    expect(JSON.parse((await localCacheDriver.get('user-a', 'items:task-1:active'))!.data)).toEqual([confirmed]);
  });

  it('uses the version shown to the editor when a background refresh advanced the cache', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.web');
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([{ id: 'item-1', sync_version: 11 }]), last_synced_at: '2026-09-28', schema_version: 1 });
    const saved = await localCacheDriver.enqueue({ ...input('shown-ten'), expected_version: 10 });
    expect(saved.expected_version).toBe(10);
  });

  it('persists a user-scoped conflict and resolves server choice atomically', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.web');
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([{ id: 'item-1', percentage: 20, is_completed: false, comment: null, sync_version: 10 }]),
      last_synced_at: '2026-09-28', schema_version: 1 });
    await localCacheDriver.put({ user_id: 'user-a', key: 'task-stats:project-1:active',
      data: JSON.stringify([{ id: 'task-1', itemCount: 1, completedCount: 0, progressPercent: 20 }]),
      last_synced_at: '2026-09-28', schema_version: 1 });
    const first = await localCacheDriver.enqueue(input('conflict-a'));
    const second = await localCacheDriver.enqueue(input('conflict-b'));
    const server = { id: 'item-1', percentage: 100, is_completed: true, comment: null, sync_version: 11 };
    const conflict: SyncConflict = { conflict_id: `user-a:item-1:${first.operation_id}`,
      user_id: 'user-a', project_id: 'project-1', task_id: 'task-1', task_item_id: 'item-1',
      operation_ids: [first.operation_id, second.operation_id], local_effective_state: { ...server, percentage: 70, is_completed: false },
      server_state: server, server_version: 11, conflicting_fields: ['progress'],
      project_name: 'Project', task_name: 'Task', item_name: 'Item',
      created_at: '2026-09-29T00:00:00Z', updated_at: '2026-09-29T00:00:00Z', status: 'unresolved' };
    await localCacheDriver.createConflict(conflict);
    vi.resetModules();
    const restarted = (await import('@/lib/local-cache/driver.web')).localCacheDriver;
    expect(await restarted.listConflicts('user-a')).toEqual([conflict]);
    expect(await restarted.listConflicts('user-b')).toEqual([]);
    expect((await restarted.listPending('user-a')).map((row) => row.status)).toEqual(['conflict', 'conflict']);
    await restarted.resolveServerConflict('user-a', conflict.conflict_id);
    expect(await restarted.listConflicts('user-a')).toEqual([]);
    expect(await restarted.listPending('user-a')).toEqual([]);
    expect((await restarted.get('user-a', 'items:task-1:active'))?.data).toContain('"percentage":100');
    expect((await restarted.get('user-a', 'task-stats:project-1:active'))?.data).toContain('"progressPercent":100');
  });

  it('commits pull rows and cursor together and ignores duplicate pages', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.web');
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([{ id: 'item-1', percentage: 20, is_completed: false, comment: null, sync_version: 10 }]),
      last_synced_at: '2026-09-28', schema_version: 1 });
    expect(await localCacheDriver.initializePullCursor('user-a', 5)).toBe(true);
    expect(await localCacheDriver.applyPullPage('user-a', 5, 6, [{ cursor: 6, task_id: 'task-1', task_item_id: 'item-1',
      change_type: 'upsert', item: { id: 'item-1', percentage: 100, is_completed: true, comment: null, sync_version: 11, is_archived: true } }])).toBe(true);
    vi.resetModules();
    const restarted = (await import('@/lib/local-cache/driver.web')).localCacheDriver;
    expect((await restarted.get('user-a', 'sync:task-items:cursor'))?.data).toBe('6');
    expect((await restarted.get('user-a', 'items:task-1:active'))?.data).toBe('[]');
    expect(await restarted.applyPullPage('user-a', 5, 7, [])).toBe(false);
    await restarted.put({ user_id: 'user-a', key: 'items:task-1:active', data: '{bad-json',
      last_synced_at: '2026-09-28', schema_version: 1 });
    await expect(restarted.applyPullPage('user-a', 6, 7, [{ cursor: 7, task_id: 'task-1', task_item_id: 'item-1',
      change_type: 'delete', item: null }])).rejects.toBeTruthy();
    expect((await restarted.get('user-a', 'sync:task-items:cursor'))?.data).toBe('6');
  });
  it('upgrades a version 1 cache without losing the confirmed entry', async () => {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('entries');
    const db = await requestDone(open);
    const entry: CacheEntry = { user_id: 'user-a', key: 'items:task-1:active', data: '[{"percentage":20}]', last_synced_at: '2026-09-28', schema_version: 1 };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('entries', 'readwrite');
      tx.objectStore('entries').put(entry, 'user-a:items:task-1:active');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const { localCacheDriver } = await import('@/lib/local-cache/driver.web');
    expect(await localCacheDriver.get('user-a', 'items:task-1:active')).toEqual(entry);
    expect(await localCacheDriver.listPending('user-a')).toEqual([]);
    const upgraded = await requestDone(indexedDB.open(name));
    expect(upgraded.version).toBe(5);
    expect([...upgraded.objectStoreNames]).toContain('pending_operations');
    expect([...upgraded.objectStoreNames]).toContain('sync_conflicts');
    upgraded.close();
  });

  it('persists concurrent writes with unique ordering and survives module reload', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.web');
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([{ id: 'item-1', sync_version: 10 }]), last_synced_at: '2026-09-28', schema_version: 1 });
    const [a, b] = await Promise.all([localCacheDriver.enqueue(input('op-a')), localCacheDriver.enqueue(input('op-b'))]);
    expect(new Set([a.sequence, b.sequence]).size).toBe(2);
    expect((await localCacheDriver.listPending('user-a')).map((op) => op.sequence)).toEqual([1, 2]);
    vi.resetModules();
    const restarted = (await import('@/lib/local-cache/driver.web')).localCacheDriver;
    expect((await restarted.listPending('user-a', 'task-1')).map((op) => op.operation_id)).toEqual(['op-a', 'op-b']);
    expect(await restarted.listPending('user-b')).toEqual([]);
    await restarted.put({ user_id: 'user-b', key: 'items:task-1:active',
      data: JSON.stringify([{ id: 'item-1', sync_version: 9 }]), last_synced_at: '2026-09-28', schema_version: 1 });
    await restarted.enqueue(input('op-c', 'user-b'));
    expect((await restarted.listPending('user-a')).length).toBe(2);
    expect((await restarted.listPending('user-b')).length).toBe(1);
  });

  it('rejects a failed transaction and leaves no acknowledged operation', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.web');
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([{ id: 'item-1', sync_version: 10 }]), last_synced_at: '2026-09-28', schema_version: 1 });
    await localCacheDriver.enqueue(input('same-id'));
    await expect(localCacheDriver.enqueue(input('same-id'))).rejects.toBeTruthy();
    expect((await localCacheDriver.listPending('user-a')).map((op) => op.operation_id)).toEqual(['same-id']);
  });

  it('upgrades a Phase 3 outbox without changing sequence or operation ID', async () => {
    const request = indexedDB.open(name, 2);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('entries');
      const outbox = request.result.createObjectStore('pending_operations', { keyPath: 'sequence', autoIncrement: true });
      outbox.createIndex('by_operation_id', 'operation_id', { unique: true });
      outbox.createIndex('by_user', 'user_id');
      outbox.createIndex('by_user_task', ['user_id', 'task_id']);
    };
    const db = await requestDone(request);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pending_operations', 'readwrite');
      tx.objectStore('pending_operations').put({ ...input('phase-3-id'), sequence: 8 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const { localCacheDriver } = await import('@/lib/local-cache/driver.web');
    expect(await localCacheDriver.listPending('user-a')).toMatchObject([{ operation_id: 'phase-3-id', sequence: 8, status: 'pending' }]);
  });

  it('keeps ACK overlay until cache replacement and deletion commit together', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.web');
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([{ id: 'item-1', percentage: 20, is_completed: false, comment: null, sync_version: 10 }]),
      last_synced_at: '2026-09-28', schema_version: 1 });
    await localCacheDriver.put({ user_id: 'user-a', key: 'task-stats:project-1:active',
      data: JSON.stringify([{ id: 'task-1', itemCount: 1, completedCount: 0, progressPercent: 20 }]),
      last_synced_at: '2026-09-28', schema_version: 1 });
    const saved = await localCacheDriver.enqueue(input('ack-id'));
    await localCacheDriver.markOperation('user-a', saved.operation_id, 'synced_unreconciled', 70);
    expect((await localCacheDriver.listPending('user-a'))[0].status).toBe('synced_unreconciled');
    expect((await localCacheDriver.get('user-a', 'items:task-1:active'))?.data).toContain('"percentage":20');
    const confirmed = { id: 'item-1', percentage: 70, is_completed: false, comment: null };
    await localCacheDriver.reconcileOperation('user-a', saved.operation_id, confirmed, [confirmed]);
    expect(await localCacheDriver.listPending('user-a')).toEqual([]);
    expect((await localCacheDriver.get('user-a', 'items:task-1:active'))?.data).toContain('"percentage":70');
    expect((await localCacheDriver.get('user-a', 'task-stats:project-1:active'))?.data).toContain('"progressPercent":70');
  });

  it('creates a confirmed active snapshot before clearing an ACK when cache was absent', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.web');
    await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
      data: JSON.stringify([{ id: 'item-1', sync_version: 10 }]), last_synced_at: '2026-09-28', schema_version: 1 });
    const saved = await localCacheDriver.enqueue(input('no-cache'));
    await localCacheDriver.remove('user-a', 'items:task-1:active');
    await localCacheDriver.markOperation('user-a', saved.operation_id, 'synced_unreconciled', 70);
    const confirmed = { id: 'item-1', percentage: 70, is_completed: false, comment: null };
    await localCacheDriver.reconcileOperation('user-a', saved.operation_id, confirmed, [confirmed]);
    expect(await localCacheDriver.listPending('user-a')).toEqual([]);
    expect((await localCacheDriver.get('user-a', 'items:task-1:active'))?.data).toContain('"percentage":70');
  });
});
