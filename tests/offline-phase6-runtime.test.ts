import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const remote = vi.hoisted(() => ({
  userId: 'user-a' as string | null, expired: false, sessionError: false, rpc: vi.fn(),
  notify: vi.fn(), status: vi.fn(), replay: vi.fn(),
  server: { id: 'item-1', task_id: 'task-1', percentage: 20, is_completed: false,
    comment: null as string | null, sync_version: 10, is_archived: false },
}));
vi.mock('@/lib/local-cache/driver', async () => import('@/lib/local-cache/driver.web'));
vi.mock('@/lib/local-cache/status', () => ({
  notifySyncState: remote.notify, updateSyncState: remote.status, markSuccessfulSync: vi.fn(),
}));
vi.mock('@/lib/env', () => ({ supabaseEnv: () => ({ url: 'http://local.test', anonKey: 'public-key' }) }));
vi.mock('@/lib/supabase/client', () => ({ supabase: {
  auth: { getSession: async () => ({ data: { session: remote.userId ? {
    user: { id: remote.userId }, access_token: 'local-test-token',
    expires_at: remote.expired ? 1 : Math.floor(Date.now() / 1000) + 3600,
  } : null }, error: remote.sessionError ? new Error('Invalid session') : null }) },
  rpc: remote.rpc,
} }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  rpc: remote.replay,
  from: () => {
    const query = {
      select: () => query, eq: () => query, order: () => query, range: () => query,
      maybeSingle: async () => ({ data: { id: 'task-1' }, error: null }),
      then: (done: (value: unknown) => unknown) => Promise.resolve({ data: [{ ...remote.server }], error: null }).then(done),
    };
    return query;
  },
}) }));

import { localCacheDriver } from '@/lib/local-cache/driver';
import { getCached } from '@/lib/local-cache/cache';
import * as cache from '@/lib/local-cache/cache';
import { enqueueOperation, applyPendingOperations } from '@/lib/local-cache/outbox';
import { clearRuntimeConfig, runtimeCapabilities, RUNTIME_CONFIG_KEY, RUNTIME_CONFIG_TTL_MS } from '@/lib/local-cache/runtime-config';
import { syncPendingOperations } from '@/lib/local-cache/sync';

const enabled = { write_enabled: true, sync_enabled: true, protocol_version: 2, updated_at: '2026-10-01T00:00:00Z' };
const disabled = { write: false, sync: false, available: false };
const allowed = { write: true, sync: true, available: true };
const persisted = () => getCached<{ user_id: string; value: typeof enabled | null; fetched_at: number }>('user-a', RUNTIME_CONFIG_KEY);
const edit = () => enqueueOperation('user-a', 'project-1', 'task-1', 'item-1',
  { type: 'set_task_item_percentage', payload: { percentage: 70 } });
async function seedItems() {
  await localCacheDriver.put({ user_id: 'user-a', key: 'items:task-1:active',
    data: JSON.stringify([remote.server]), last_synced_at: new Date().toISOString(), schema_version: 1 });
  await localCacheDriver.initializePullCursor('user-a', 0);
}
beforeEach(async () => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules();
  clearRuntimeConfig();
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.deleteDatabase('tasktrace-local-cache');
    r.onsuccess = () => resolve(); r.onerror = () => reject(r.error);
  });
  remote.userId = 'user-a'; remote.expired = false; remote.sessionError = false;
  remote.rpc.mockReset().mockResolvedValue({ data: { ...enabled }, error: null, status: 200 });
  remote.notify.mockClear(); remote.status.mockClear(); remote.replay.mockReset();
  remote.server = { id: 'item-1', task_id: 'task-1', percentage: 20, is_completed: false,
    comment: null, sync_version: 10, is_archived: false };
  remote.replay.mockImplementation(async (name: string, args: { p_percentage?: number }) => {
    if (name === 'pull_task_item_changes_v2')
      return { data: { changes: [], next_cursor: 0, has_more: false }, error: null };
    remote.server.percentage = args.p_percentage!; remote.server.sync_version += 1;
    return { data: { status: 'applied', version: remote.server.sync_version, item: { ...remote.server } }, error: null };
  });
  vi.stubEnv('EXPO_PUBLIC_OFFLINE_WRITE_ENABLED', 'true');
  vi.stubEnv('EXPO_PUBLIC_OFFLINE_SYNC_ENABLED', 'true');
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('persistent user-scoped runtime capabilities', () => {
  it('persists the validated server confirmation using entries and keeps IndexedDB v5', async () => {
    expect(await runtimeCapabilities('user-a')).toEqual(allowed);
    expect(await persisted()).toEqual({ user_id: 'user-a', value: enabled, fetched_at: expect.any(Number) });
    expect(remote.notify).toHaveBeenCalledWith('user-a');
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open('tasktrace-local-cache'); r.onsuccess = () => resolve(r.result);
    });
    expect(db.version).toBe(5);
    expect(Array.from(db.objectStoreNames)).toEqual(['entries', 'pending_operations', 'sync_conflicts']); db.close();
  });

  it('keeps build flags as a hard ceiling, including sync-only queue drain', async () => {
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_WRITE_ENABLED', 'false');
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_SYNC_ENABLED', 'false');
    expect(await runtimeCapabilities('user-a')).toEqual({ write: false, sync: false, available: true });
    expect(remote.rpc).not.toHaveBeenCalled();
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_SYNC_ENABLED', 'true');
    expect(await runtimeCapabilities('user-a')).toEqual({ write: false, sync: true, available: true });
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_WRITE_ENABLED', 'true');
    remote.rpc.mockResolvedValue({ data: { ...enabled, sync_enabled: false }, error: null });
    expect(await runtimeCapabilities('user-a', true)).toMatchObject({ write: false, sync: false });
    remote.rpc.mockResolvedValue({ data: { ...enabled, write_enabled: false }, error: null });
    expect(await runtimeCapabilities('user-a', true)).toMatchObject({ write: false, sync: true });
  });

  it('restores all three outbox mutations after a real module reload offline with an expired TTL', async () => {
    await runtimeCapabilities('user-a'); await seedItems();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + RUNTIME_CONFIG_TTL_MS + 1);
    vi.resetModules();
    const restarted = await import('@/lib/local-cache/runtime-config');
    const outbox = await import('@/lib/local-cache/outbox');
    vi.stubGlobal('navigator', { onLine: false });
    expect(await restarted.runtimeCapabilities('user-a')).toEqual(allowed);
    const edits = [
      { type: 'set_task_item_state' as const, payload: { completed: true } },
      { type: 'set_task_item_percentage' as const, payload: { percentage: 70 } },
      { type: 'set_task_item_comment' as const, payload: { comment: 'Offline reload comment' } },
    ];
    for (const item of edits) await outbox.enqueueOperation('user-a', 'project-1', 'task-1', 'item-1', item);
    const pending = await localCacheDriver.listPending('user-a');
    expect(pending.map((row) => row.type)).toEqual(edits.map((row) => row.type));
    expect(applyPendingOperations([remote.server], pending, 'user-a', 'task-1')[0])
      .toMatchObject({ percentage: 70, is_completed: false, comment: 'Offline reload comment' });
    expect(remote.rpc).toHaveBeenCalledTimes(1);
  });

  it('refreshes after TTL online, and on startup even for a fresh persisted snapshot', async () => {
    await runtimeCapabilities('user-a');
    await runtimeCapabilities('user-a'); expect(remote.rpc).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + RUNTIME_CONFIG_TTL_MS + 1);
    await runtimeCapabilities('user-a'); expect(remote.rpc).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks(); clearRuntimeConfig();
    await runtimeCapabilities('user-a'); expect(remote.rpc).toHaveBeenCalledTimes(3);
  });

  it.each(['Failed to fetch', 'fetch failed', 'Network request failed', 'DNS network error', 'timeout'])(
    'uses persisted confirmation only for transport failure: %s', async (message) => {
      await runtimeCapabilities('user-a'); clearRuntimeConfig();
      remote.rpc.mockRejectedValue(new Error(message));
      expect(await runtimeCapabilities('user-a')).toEqual(allowed);
      expect(await runtimeCapabilities('user-a', true, { requireServer: true })).toEqual(disabled);
    });

  it.each([
    { status: 401, error: { message: 'Failed to fetch' } },
    { status: 403, error: { message: 'Denied' } },
    { status: 400, error: { code: 'PGRST301', message: 'Invalid JWT' } },
    { status: 400, error: { code: '42501', message: 'Access denied' } },
    { status: 0, error: { message: 'Access denied: network error' } },
    { status: 400, error: { code: '22023', message: 'Business rejection' } },
    { status: 200, error: null, data: { ...enabled, protocol_version: 99 } },
  ])('never falls back after authorization/business/invalid response, even on later offline reload: $status $error', async (response) => {
    await runtimeCapabilities('user-a');
    remote.rpc.mockResolvedValue({ data: null, ...response });
    expect(await runtimeCapabilities('user-a', true)).toEqual(disabled);
    expect((await persisted())?.value).toBeNull();
    clearRuntimeConfig(); vi.stubGlobal('navigator', { onLine: false });
    expect(await runtimeCapabilities('user-a')).toEqual(disabled);
  });

  it('persists server false, blocks new mutations and retains existing pending data', async () => {
    await runtimeCapabilities('user-a'); await seedItems();
    vi.stubGlobal('navigator', { onLine: false }); const operation = await edit();
    vi.stubGlobal('navigator', { onLine: true });
    remote.rpc.mockResolvedValue({ data: { ...enabled, write_enabled: false, sync_enabled: false }, error: null });
    await syncPendingOperations('user-a', true);
    expect(remote.status).toHaveBeenCalledWith('user-a', expect.objectContaining({ lastErrorKind: 'disabled' }), expect.objectContaining({ userId: 'user-a', slot: 'sync' }));
    expect(remote.replay).not.toHaveBeenCalled();
    expect((await persisted())?.value).toMatchObject({ write_enabled: false, sync_enabled: false });
    vi.stubGlobal('navigator', { onLine: false });
    await expect(edit()).rejects.toThrow('отключено');
    expect((await localCacheDriver.listPending('user-a')).map((row) => row.operation_id)).toEqual([operation.operation_id]);
  });

  it('revalidates on reconnect, ACKs the existing operation and clears the outbox', async () => {
    await runtimeCapabilities('user-a'); await seedItems();
    vi.stubGlobal('navigator', { onLine: false }); const operation = await edit();
    clearRuntimeConfig(); vi.stubGlobal('navigator', { onLine: true });
    await syncPendingOperations('user-a', true);
    expect(remote.rpc.mock.invocationCallOrder[1]).toBeLessThan(remote.replay.mock.invocationCallOrder[0]);
    expect(remote.replay).toHaveBeenCalledWith('apply_task_item_percentage_operation_v2',
      expect.objectContaining({ p_operation_id: operation.operation_id, p_percentage: 70 }));
    expect(remote.server.percentage).toBe(70);
    expect(await localCacheDriver.listPending('user-a')).toEqual([]);
  });

  it.each([true, false])('isolates both account-switch directions (A=$0)', async (aEnabled) => {
    remote.rpc.mockResolvedValue({ data: { ...enabled, write_enabled: aEnabled }, error: null });
    expect((await runtimeCapabilities('user-a')).write).toBe(aEnabled);
    remote.userId = null; clearRuntimeConfig();
    expect(await runtimeCapabilities('user-a')).toEqual(disabled);
    remote.userId = 'user-b';
    remote.rpc.mockResolvedValue({ data: { ...enabled, write_enabled: !aEnabled }, error: null });
    expect(await runtimeCapabilities('user-a')).toEqual(disabled);
    expect((await runtimeCapabilities('user-b')).write).toBe(!aEnabled);
    clearRuntimeConfig(); vi.stubGlobal('navigator', { onLine: false });
    expect((await runtimeCapabilities('user-b')).write).toBe(!aEnabled);
    remote.userId = 'user-a';
    expect((await runtimeCapabilities('user-a')).write).toBe(aEnabled);
  });

  it.each(['logout', 'expired', 'invalid'])('requires a current valid session: %s', async (kind) => {
    await runtimeCapabilities('user-a'); await seedItems();
    vi.stubGlobal('navigator', { onLine: false });
    if (kind === 'logout') remote.userId = null;
    if (kind === 'expired') remote.expired = true;
    if (kind === 'invalid') remote.sessionError = true;
    expect(await runtimeCapabilities('user-a')).toEqual(disabled);
    await expect(edit()).rejects.toThrow();
    expect(await localCacheDriver.listPending('user-a')).toEqual([]);
  });

  it('rejects another user or malformed persisted snapshot', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    for (const data of [
      { user_id: 'user-b', value: enabled, fetched_at: Date.now() },
      { user_id: 'user-a', value: { ...enabled, write_enabled: 'true' }, fetched_at: Date.now() },
    ]) {
      await localCacheDriver.put({ user_id: 'user-a', key: RUNTIME_CONFIG_KEY, data: JSON.stringify(data),
        last_synced_at: new Date().toISOString(), schema_version: 1 });
      expect(await runtimeCapabilities('user-a')).toEqual(disabled);
    }
  });

  it('reads another tab\'s disable immediately without retaining a volatile true', async () => {
    await runtimeCapabilities('user-a');
    vi.resetModules(); const secondTab = await import('@/lib/local-cache/runtime-config');
    remote.rpc.mockResolvedValue({ data: { ...enabled, write_enabled: false }, error: null });
    expect((await secondTab.runtimeCapabilities('user-a', true)).write).toBe(false);
    vi.stubGlobal('navigator', { onLine: false });
    expect((await runtimeCapabilities('user-a')).write).toBe(false);
  });

  it('cannot persist an in-flight response after account switch or logout/relogin', async () => {
    let finish!: (value: unknown) => void;
    remote.rpc.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const request = runtimeCapabilities('user-a');
    await vi.waitFor(() => expect(remote.rpc).toHaveBeenCalled());
    remote.userId = 'user-b'; clearRuntimeConfig(); remote.userId = 'user-a';
    finish({ data: enabled, error: null });
    expect(await request).toEqual(disabled);
    expect(await persisted()).toBeNull();
  });

  it('rejects a cached confirmation when logout/relogin occurs during the session check', async () => {
    await runtimeCapabilities('user-a');
    vi.stubGlobal('navigator', { onLine: false });
    let finish!: (userId: string) => void;
    const session = vi.spyOn(cache, 'activeCacheUserId')
      .mockResolvedValueOnce('user-a')
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const request = runtimeCapabilities('user-a');
    await vi.waitFor(() => expect(session).toHaveBeenCalledTimes(2));
    clearRuntimeConfig();
    finish('user-a');
    expect(await request).toEqual(disabled);
  });

  it('deduplicates a refresh without letting replay inherit transport fallback', async () => {
    await runtimeCapabilities('user-a');
    let fail!: (error: unknown) => void;
    remote.rpc.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const write = runtimeCapabilities('user-a', true);
    await vi.waitFor(() => expect(remote.rpc).toHaveBeenCalledTimes(2));
    const replay = runtimeCapabilities('user-a', true, { requireServer: true });
    fail(new Error('Failed to fetch'));
    expect(await write).toEqual(allowed); expect(await replay).toEqual(disabled);
    expect(remote.rpc).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['2026-10-01T00:00:00Z', '2026-10-01T01:00:00Z'],
    ['2026-10-01T00:00:00.123455Z', '2026-10-01T00:00:00.123456+00:00'],
    ['2026-10-01T00:00:00.123455Z', '2026-10-01T03:00:00.123456+03:00'],
  ])('does not let a slow %s response undo newer %s saved by another tab', async (older, newer) => {
    let finish!: (value: unknown) => void;
    remote.rpc.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const request = runtimeCapabilities('user-a');
    await vi.waitFor(() => expect(remote.rpc).toHaveBeenCalled());
    await localCacheDriver.put({ user_id: 'user-a', key: RUNTIME_CONFIG_KEY,
      data: JSON.stringify({ user_id: 'user-a', fetched_at: Date.now() - 1,
        value: { ...enabled, write_enabled: false, updated_at: newer } }),
      last_synced_at: new Date().toISOString(), schema_version: 1 });
    finish({ data: { ...enabled, updated_at: older }, error: null });
    expect((await request).write).toBe(false);
    expect((await persisted())?.value?.write_enabled).toBe(false);
  });
});
