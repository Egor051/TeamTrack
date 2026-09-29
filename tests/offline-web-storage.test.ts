import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheEntry, OfflineOperationInput } from '@/lib/local-cache/types';

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
    expect(upgraded.version).toBe(3);
    expect([...upgraded.objectStoreNames]).toContain('pending_operations');
    upgraded.close();
  });

  it('persists concurrent writes with unique ordering and survives module reload', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.web');
    const [a, b] = await Promise.all([localCacheDriver.enqueue(input('op-a')), localCacheDriver.enqueue(input('op-b'))]);
    expect(new Set([a.sequence, b.sequence]).size).toBe(2);
    expect((await localCacheDriver.listPending('user-a')).map((op) => op.sequence)).toEqual([1, 2]);
    vi.resetModules();
    const restarted = (await import('@/lib/local-cache/driver.web')).localCacheDriver;
    expect((await restarted.listPending('user-a', 'task-1')).map((op) => op.operation_id)).toEqual(['op-a', 'op-b']);
    expect(await restarted.listPending('user-b')).toEqual([]);
    await restarted.enqueue(input('op-c', 'user-b'));
    expect((await restarted.listPending('user-a')).length).toBe(2);
    expect((await restarted.listPending('user-b')).length).toBe(1);
  });

  it('rejects a failed transaction and leaves no acknowledged operation', async () => {
    const { localCacheDriver } = await import('@/lib/local-cache/driver.web');
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
      data: JSON.stringify([{ id: 'item-1', percentage: 20, is_completed: false, comment: null }]),
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
    const saved = await localCacheDriver.enqueue(input('no-cache'));
    await localCacheDriver.markOperation('user-a', saved.operation_id, 'synced_unreconciled', 70);
    const confirmed = { id: 'item-1', percentage: 70, is_completed: false, comment: null };
    await localCacheDriver.reconcileOperation('user-a', saved.operation_id, confirmed, [confirmed]);
    expect(await localCacheDriver.listPending('user-a')).toEqual([]);
    expect((await localCacheDriver.get('user-a', 'items:task-1:active'))?.data).toContain('"percentage":70');
  });
});
