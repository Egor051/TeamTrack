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
    expect(upgraded.version).toBe(2);
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
});
