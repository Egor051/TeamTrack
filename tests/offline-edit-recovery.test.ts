import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '@/lib/supabase/client';

const f = vi.hoisted(() => ({ version: 1, user: 'user', expired: false, canWrite: true, available: true, rpc: vi.fn() }));
vi.mock('@/lib/local-cache/driver', async () => import('@/lib/local-cache/driver.web'));
vi.mock('@/lib/local-cache/runtime-config', () => ({
  buildWriteEnabled: () => true, buildSyncEnabled: () => true,
  runtimeCapabilities: async () => ({ write: f.canWrite, sync: true, available: f.available }),
  localWriteDenial: async () => { const { OperationError } = await import('@/lib/errors/operation-error'); return new OperationError(f.expired ? 'session' : 'server', f.expired ? 'TT_SESSION' : 'TT_CAPABILITIES', 'capabilities'); },
}));
vi.mock('@/lib/local-cache/sync', () => ({ announceSyncChange: vi.fn(), subscribeSyncChanges: vi.fn(), syncPendingOperations: vi.fn(async () => undefined) }));
vi.mock('@/lib/local-cache/status', () => ({ getSyncState: vi.fn(), subscribeSyncState: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ supabase: {
  auth: { getSession: async () => ({ data: { session: { user: { id: f.user }, expires_at: f.expired ? 1 : Date.now() / 1000 + 3600 } }, error: null }) },
  rpc: f.rpc,
  from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { id: 'task' }, error: null }) }; return q; },
} }));
import { localCacheDriver as driver } from '@/lib/local-cache/driver';
import { ChecklistLocalRepository } from '@/lib/local-cache/repository';
import { performSupportedEdit } from '@/lib/local-cache/edit';
import { classifyError } from '@/lib/errors/operation-error';
import { reportBrowserConnectivity } from '@/lib/connectivity/state';

const item = (): TaskItem => ({ id: 'item', task_id: 'task', sync_version: f.version, percentage: 0, is_completed: false, comment: null, is_archived: false, position: 1 } as TaskItem);
const edits = [{ type: 'set_task_item_state' as const, payload: { completed: true } }, { type: 'set_task_item_percentage' as const, payload: { percentage: 50 } }, { type: 'set_task_item_comment' as const, payload: { comment: 'private draft' } }];
const base = { userId: 'user', projectId: 'project', taskId: 'task', itemId: 'item', itemVersion: 1, offline: false };
const recover = () => ChecklistLocalRepository.recoverItemSnapshot('user', 'task', 'item', 1);
const save = () => driver.put({ user_id: 'user', key: 'items:task:active', data: JSON.stringify([item()]), last_synced_at: new Date().toISOString(), schema_version: 1 });
beforeEach(async () => {
  await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase('tasktrace-local-cache'); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
  f.version = 1; f.user = 'user'; f.expired = false; f.canWrite = true; f.available = true;
  f.rpc.mockReset().mockImplementation(async () => ({ data: { revision: f.version, total: 1, offset: 0, rows: [item()] }, error: null }));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('durable checklist edit recovery', () => {
  it.each(edits)('reproduces successful rendering after a failed cache write and repairs before $type', async edit => {
    const original = driver.commitCacheBatch.bind(driver);
    const fail = vi.spyOn(driver, 'commitCacheBatch').mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'));
    const rendered = await ChecklistLocalRepository.refreshTaskItems('user', 'task', 'active');
    expect(rendered[0].sync_version).toBe(1); expect(await driver.get('user', 'items:task:active')).toBeNull();
    fail.mockImplementation(original);
    const onlineAction = vi.fn();
    expect((await performSupportedEdit({ ...base, edit, onlineAction, recoverLocalSnapshot: recover })).kind).toBe('local');
    const queued = await driver.listPending('user'); expect(queued).toHaveLength(1); expect(queued[0].expected_version).toBe(1);
    expect(queued[0].type).toBe(edit.type); expect(onlineAction).not.toHaveBeenCalled(); expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it('repairs a corrupt snapshot once while retaining the originally displayed CAS version', async () => {
    await driver.put({ user_id: 'user', key: 'items:task:active', data: '{broken', last_synced_at: '', schema_version: 1 });
    await performSupportedEdit({ ...base, edit: edits[0], onlineAction: vi.fn(), recoverLocalSnapshot: recover });
    expect((await driver.listPending('user'))[0].expected_version).toBe(1); expect(f.rpc).toHaveBeenCalledOnce();
  });
  it('preserves a draft instead of rebasing it silently to a newer server version', async () => {
    f.version = 2;
    const error = await performSupportedEdit({ ...base, edit: edits[2], onlineAction: vi.fn(), recoverLocalSnapshot: recover }).catch(e => e);
    expect(classifyError(error)).toBe('conflict'); expect(error.code).toBe('PT409'); expect(await driver.listPending('user')).toEqual([]);
    expect(edits[2].payload.comment).toBe('private draft');
  });
  it('does not repair offline, bypass the server capability check, or retry an ambiguous storage failure', async () => {
    reportBrowserConnectivity(false); const recovery = vi.fn();
    const offline = await performSupportedEdit({ ...base, offline: true, edit: edits[0], onlineAction: vi.fn(), recoverLocalSnapshot: recovery }).catch(e => e);
    expect(classifyError(offline)).toBe('local_data'); expect(recovery).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
    reportBrowserConnectivity(true); await save();
    vi.spyOn(driver, 'enqueue').mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'));
    const storage = await performSupportedEdit({ ...base, edit: edits[0], onlineAction: vi.fn(), recoverLocalSnapshot: recovery }).catch(e => e);
    expect(classifyError(storage)).toBe('storage_full'); expect(recovery).not.toHaveBeenCalled(); expect(await driver.listPending('user')).toEqual([]);
  });
  it.each(['failed', 'conflict'] as const)('keeps a %s chain and does not refresh or clear it', async status => {
    await save(); const first = await driver.enqueue({ operation_id: crypto.randomUUID(), user_id: 'user', project_id: 'project', task_id: 'task', task_item_id: 'item', ...edits[0], status: 'pending', created_at: new Date().toISOString(), expected_version: 1 });
    await driver.markOperation('user', first.operation_id, status);
    const recovery = vi.fn(); const error = await performSupportedEdit({ ...base, edit: edits[1], onlineAction: vi.fn(), recoverLocalSnapshot: recovery }).catch(e => e);
    expect(classifyError(error)).toBe('outbox_blocked'); expect(recovery).not.toHaveBeenCalled();
    expect((await driver.listPending('user')).map(o => o.operation_id)).toEqual([first.operation_id]);
  });
  it.each(edits)('keeps $type available offline when its confirmed base and capabilities are valid', async edit => {
    await save(); reportBrowserConnectivity(false);
    expect((await performSupportedEdit({ ...base, offline: true, edit, onlineAction: vi.fn() })).kind).toBe('local');
    expect((await driver.listPending('user'))[0].type).toBe(edit.type);
  });
  it('fails explicitly if repairing the cache still cannot persist it', async () => {
    vi.spyOn(driver, 'commitCacheBatch').mockRejectedValue(new DOMException('quota', 'QuotaExceededError'));
    const error = await performSupportedEdit({ ...base, edit: edits[0], onlineAction: vi.fn(), recoverLocalSnapshot: recover }).catch(e => e);
    expect(classifyError(error)).toBe('storage_full'); expect(error.name).toBe('QuotaExceededError');
    expect(f.rpc).toHaveBeenCalledOnce(); expect(await driver.listPending('user')).toEqual([]);
  });
  it('reports session expiration without relaxing offline authorization', async () => {
    await save(); f.canWrite = false; f.available = false; f.expired = true; reportBrowserConnectivity(false);
    const error = await performSupportedEdit({ ...base, offline: true, edit: edits[0], onlineAction: vi.fn() }).catch(e => e);
    expect(classifyError(error)).toBe('session'); expect(await driver.listPending('user')).toEqual([]);
  });
});
