import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountManifest, Dataset } from '@/lib/local-cache/bootstrap-types';
import { BASIC_DATASETS, EXTENDED_DATASETS, BOOTSTRAP_KEY, initialBootstrap } from '@/lib/local-cache/bootstrap-types';

const f = vi.hoisted(() => ({ user: '00000000-0000-4000-8000-000000000001', rpc: vi.fn(), from: vi.fn(),
  failure: null as { dataset?: string; offset?: number; error: unknown } | null, rows: {} as Record<string, unknown[]> }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { rpc: f.rpc, from: f.from, auth: {
  getSession: async () => ({ data: { session: { user: { id: f.user }, expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }),
} } }));
vi.mock('@/features/auth/auth', () => ({ getCurrentUser: async () => ({ data: { user: { id: f.user } }, error: null }) }));
vi.mock('@/lib/local-cache/driver', async () => await import('@/lib/local-cache/driver.web'));

const projectId = '00000000-0000-4000-8000-000000000010';
const archiveId = '00000000-0000-4000-8000-000000000011';
const taskId = '00000000-0000-4000-8000-000000000020';
const archivedTaskId = '00000000-0000-4000-8000-000000000021';
const itemId = '00000000-0000-4000-8000-000000000030';
const templateId = '00000000-0000-4000-8000-000000000040';
const transport = { message: 'Failed to fetch', status: 0 };
const stamp = new Date().toISOString();
const day = new Date(); day.setUTCHours(0, 0, 0, 0);
function revision(name: string) { return createHash('md5').update(JSON.stringify(f.rows[name])).digest('hex'); }
function manifest(extended: boolean): AccountManifest {
  const utc3 = new Date(Date.now() + 3 * 3600000); utc3.setUTCHours(0, 0, 0, 0);
  return { schema_version: 1, user_id: f.user, generated_at: stamp, snapshot_at: stamp, day_start: new Date(utc3.getTime() - 3 * 3600000).toISOString(),
    history_start: new Date(Date.now() - 90 * 86400000).toISOString(), datasets: Object.fromEntries((extended ? [...BASIC_DATASETS, ...EXTENDED_DATASETS] : BASIC_DATASETS)
      .map((name) => [name, { count: f.rows[name].length, revision: revision(name), pages: Array.from({ length: Math.ceil(f.rows[name].length / 500) }, (_, page) =>
        createHash('md5').update(JSON.stringify(f.rows[name].slice(page * 500, page * 500 + 500))).digest('hex')) }])) };
}
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(stamp));
  vi.resetModules(); vi.clearAllMocks(); f.user = '00000000-0000-4000-8000-000000000001'; f.failure = null;
  await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase('tasktrace-local-cache'); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
  const profile = { id: f.user, display_name: 'Offline user' };
  const project = { id: projectId, name: 'Active project', role: 'owner', status: 'active', created_at: stamp };
  const task = { id: taskId, project_id: projectId, title: 'Active stage', position: 1, created_at: stamp, status: 'in_progress' };
  const item = { id: itemId, task_id: taskId, title: 'Current comment', comment: 'Saved comment', position: 1, percentage: 40, is_completed: false, is_archived: false, sync_version: 4 };
  f.rows = { profile: [profile], projects: [project, { ...project, id: archiveId, name: 'Archive', status: 'archived' }],
    members: [{ project_id: projectId, user_id: f.user, role: 'owner' }], profiles: [profile],
    tasks: [task, { ...task, id: archivedTaskId, project_id: archiveId, status: 'archived' }],
    roles: [{ task_id: taskId, role: 'owner' }, { task_id: archivedTaskId, role: 'viewer' }], overrides: [],
    assignees: [{ task_id: taskId, user_id: f.user }], items: [item, { ...item, id: 'archived-item', task_id: archivedTaskId, is_archived: true }],
    templates: [{ id: templateId, name: 'Template' }], template_items: [{ id: 'template-item', template_id: templateId, title: 'Template content', position: 1, created_at: stamp }],
    daily_audit: [{ id: 1, project_id: projectId, entity_type: 'task_item', entity_id: itemId, created_at: stamp, action: 'updated', old_data: { percentage: 20 }, new_data: { percentage: 40 } }],
    history: [{ id: 1, project_id: projectId, entity_type: 'task_item', entity_id: itemId, created_at: stamp }],
    notifications: [{ id: 'notification', title: 'Notice', created_at: stamp, is_read: false }], last_editors: [{ task_id: taskId, task_item_id: itemId, display_name: 'Editor' }] };
  f.rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
    const result = async () => {
      if (name === 'get_offline_account_manifest') return { data: manifest(args.p_scheme === 'extended'), error: f.failure?.dataset === 'manifest' ? f.failure.error : null };
      if (name !== 'get_offline_account_page') return { data: null, error: transport };
      const dataset = args.p_dataset as Dataset;
      if (f.failure?.dataset === dataset && (f.failure.offset === undefined || args.p_offset === f.failure.offset)) return { data: null, error: f.failure.error };
      return { data: { revision: revision(dataset), total: f.rows[dataset].length, offset: args.p_offset,
        rows: f.rows[dataset].slice(args.p_offset as number, (args.p_offset as number) + (args.p_limit as number)) }, error: null };
    };
    return { abortSignal: () => result(), then: (...args: Parameters<ReturnType<typeof result>['then']>) => result().then(...args) };
  });
  const query = { select: () => query, eq: () => query, in: () => query, order: () => query, gte: () => query, lte: () => query,
    range: () => query, maybeSingle: async () => ({ data: null, error: transport }),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error: transport }).then(resolve) };
  f.from.mockReturnValue(query);
  vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ active: {} }) } });
  vi.stubGlobal('caches', { match: async () => ({}) }); vi.stubGlobal('document', { scripts: [] });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function advance(b: typeof import('@/lib/local-cache/bootstrap')) {
  vi.setSystemTime(Date.now() + b.bootstrapDelay(await b.getBootstrapMetadata(f.user)) + 1);
}
async function again(b: typeof import('@/lib/local-cache/bootstrap')) {
  // Explicit retries in the older lifecycle tests occur after the shared gate.
  // Drain a scheme change's superseded promise before advancing the clock.
  if (b.bootstrapDelay(await b.getBootstrapMetadata(f.user)) > 0) {
    await b.runAccountBootstrap(f.user, true); await advance(b);
  }
  await b.runAccountBootstrap(f.user, true);
}
async function run() { const b = await import('@/lib/local-cache/bootstrap'); await again(b); return b; }
async function stored(key: string) { const d = (await import('@/lib/local-cache/driver.web')).localCacheDriver; const e = await d.get(f.user, key); return e ? JSON.parse(e.data) : null; }
function pages(name?: string) { return f.rpc.mock.calls.filter(([rpc, args]) => rpc === 'get_offline_account_page' && (!name || args.p_dataset === name)); }

describe('account bootstrap', () => {
  it.each(['missing', 'corrupt'])('recovery downloads only the %s page of a multi-page dataset', async (damage) => {
    const item = f.rows.items[0] as Record<string, unknown>;
    f.rows.items = Array.from({ length: 1001 }, (_, index) => ({ ...item, id: `item-${index}`, position: index }));
    const b = await run();
    const driver = (await import('@/lib/local-cache/driver.web')).localCacheDriver;
    const { batchKey } = await import('@/lib/local-cache/bootstrap-types');
    const key = batchKey('items', revision('items'), 500);
    if (damage === 'missing') await driver.remove(f.user, key);
    else { const entry = (await driver.get(f.user, key))!; const rows = JSON.parse(entry.data); rows[0].id = 'corrupted'; await driver.put({ ...entry, data: JSON.stringify(rows) }); }
    expect((await b.getBootstrapMetadata(f.user)).basic_ready).toBe(false);
    f.rpc.mockClear(); await advance(b); await b.runAccountBootstrap(f.user);
    expect(pages().map(([, args]) => [args.p_dataset, args.p_offset])).toEqual([['items', 500]]);
    expect((await b.getBootstrapMetadata(f.user)).basic_ready).toBe(true);
  });
  it('AUD-02: bootstrap keeps history of a hard-deleted item and its earlier events', async () => {
    f.rows.history = [
      { id: 1, project_id: projectId, entity_type: 'task_item', entity_id: 'deleted-item', action: 'updated', old_data: { percentage: 0 }, new_data: { percentage: 50 }, created_at: stamp },
      { id: 2, project_id: projectId, entity_type: 'task_item', entity_id: 'deleted-item', action: 'removed', old_data: { task_id: taskId }, new_data: null, created_at: stamp },
    ];
    const b = await run(); await b.selectOfflineScheme(f.user, 'extended'); await again(b);
    expect((await stored(`audit:${taskId}:90days`) as { id: number }[]).map((row) => row.id)).toEqual([2, 1]);
  });
  it('AUD-10: notification page/count bypass Supabase Auth and HTTP while already offline', async () => {
    const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    await driver.put({ user_id: f.user, key: 'notifications:window', data: JSON.stringify({ rows: f.rows.notifications, read_limit: 100 }), last_synced_at: '', schema_version: 1 });
    const state = await import('@/lib/connectivity/state'); state.reportConnectivityFailure(new TypeError('Failed to fetch'));
    f.from.mockClear();
    const notifications = await import('@/features/notifications/notifications');
    expect(await notifications.fetchNotificationPage()).toMatchObject({ offline: true, rows: [{ id: 'notification' }] });
    expect(await notifications.fetchUnreadCount()).toBe(1);
    expect(f.from).not.toHaveBeenCalled();
  });
  it.each(['insert', 'delete'])('AUD-09: pull after final manifest verification cannot be overwritten by bootstrap (%s)', async (change) => {
    const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    await driver.initializePullCursor(f.user, 0);
    const rpc = f.rpc.getMockImplementation()!;
    let manifests = 0;
    f.rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      const query = rpc(name, args);
      const read = async () => {
        const result = await query;
        if (name === 'get_offline_account_manifest' && ++manifests === 2) {
          const newer = change === 'insert' ? { ...f.rows.items[0] as object, id: 'new-item', sync_version: 5 } : null;
          const id = change === 'insert' ? 'new-item' : itemId;
          await driver.put({ user_id: f.user, key: `items:${taskId}:active`, data: JSON.stringify(f.rows.items.filter((row) => (row as { task_id: string }).task_id === taskId)), last_synced_at: '', schema_version: 1 });
          await driver.applyPullPage(f.user, 0, 10, [{ cursor: 10, task_id: taskId, task_item_id: id, change_type: newer ? 'upsert' : 'delete', item: newer as import('@/lib/local-cache/types').ReconciledItem | null }]);
          f.rows.items = change === 'insert' ? [...f.rows.items, newer] : f.rows.items.filter((row) => (row as { id: string }).id !== itemId);
        }
        return result;
      };
      return { abortSignal: read, then: (...args: Parameters<ReturnType<typeof read>['then']>) => read().then(...args) };
    });
    await run();
    const ids = (await stored(`items:${taskId}:active`) as { id: string }[]).map((row) => row.id);
    expect(ids).toEqual(change === 'insert' ? [itemId, 'new-item'] : []);
    expect(await stored('sync:task-items:cursor')).toBe(10);
  });
  it('AUD-09/13: a newer revoke fences a verified snapshot even when its tombstone write fails', async () => {
    const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    const cache = await import('@/lib/local-cache/cache');
    const rpc = f.rpc.getMockImplementation()!;
    let manifests = 0;
    f.rpc.mockImplementation((name: string, args: Record<string, unknown>) => {
      const query = rpc(name, args);
      const read = async () => {
        const result = await query;
        if (name === 'get_offline_account_manifest' && ++manifests === 2) {
          vi.spyOn(console, 'warn').mockImplementation(() => undefined);
          const failedWrite = vi.spyOn(driver, 'put').mockRejectedValueOnce(new Error('IndexedDB write failed'));
          await cache.putCached(f.user, `blocked:${projectId}`, true); failedWrite.mockRestore();
          // RLS now hides the revoked project. The just-verified response still
          // belongs to the earlier generation and must be discarded.
          f.rows.projects = f.rows.projects.filter((row) => (row as { id: string }).id !== projectId);
          f.rows.tasks = f.rows.tasks.filter((row) => (row as { project_id: string }).project_id !== projectId);
          f.rows.roles = f.rows.roles.filter((row) => (row as { task_id: string }).task_id !== taskId);
          f.rows.items = f.rows.items.filter((row) => (row as { task_id: string }).task_id !== taskId);
        }
        return result;
      };
      return { abortSignal: read, then: (...args: Parameters<ReturnType<typeof read>['then']>) => read().then(...args) };
    });
    await run();
    expect(manifests).toBeGreaterThan(2);
    expect(await cache.getCached(f.user, `blocked:${projectId}`)).toBe(true);
    expect(await cache.filterBlockedProjects(f.user, [{ id: projectId }])).toEqual([]);
  });
  it('reload during preparation restores durable data without a fictional running operation', async () => {
    const b = await run(); const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    const entry = (await driver.get(f.user, BOOTSTRAP_KEY))!;
    await driver.put({ ...entry, data: JSON.stringify({ ...JSON.parse(entry.data), status: 'running', progress: 94,
      lease: { owner: 'closed-runtime', expires_at: Date.now() + 45_000 } }) });
    vi.resetModules(); const fresh = await import('@/lib/local-cache/bootstrap');
    expect(await fresh.getBootstrapMetadata(f.user)).toMatchObject({ status: 'ready', basic_ready: true, progress: 100 });
    expect((await import('@/lib/local-cache/runtime-state')).getOfflineRuntime(f.user).operations.preparation).toBeUndefined();
    const current = await driver.get(f.user, BOOTSTRAP_KEY);
    await driver.put({ ...current!, data: JSON.stringify({ ...JSON.parse(current!.data), verified: { basic: null, extended: null },
      basic_ready: false, offline_ready: false, status: 'updating' }) });
    expect((await fresh.getBootstrapMetadata(f.user)).status).toBe('partial');
  });
  it('checks actual Basic batches and committed models instead of trusting a ready flag', async () => {
    const b = await run(); const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    await driver.remove(f.user, 'templates');
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ basic_ready: false, offline_ready: false, status: 'partial' });
    await b.retryAccountBootstrap(f.user); expect((await b.getBootstrapMetadata(f.user)).basic_ready).toBe(true);
    const profile = (await driver.get(f.user, 'profile:self'))!; await driver.put({ ...profile, data: 'null' });
    expect((await b.getBootstrapMetadata(f.user)).basic_ready).toBe(false);
  });
  it('authorized foreground reads may clear false access markers without invalidating a ready certificate', async () => {
    const b = await run(); const cache = await import('@/lib/local-cache/cache');
    await cache.reconcileVisibleProjects(f.user, [{ id: projectId }], [{ id: projectId }]);
    await cache.reconcileVisibleTasks(f.user, [{ id: taskId }], [{ id: taskId }]);
    expect(await stored(`blocked:${projectId}`)).toBeNull();
    expect(await stored(`blocked-task:${taskId}`)).toBeNull();
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ status: 'ready', basic_ready: true, offline_ready: true });
    f.rpc.mockClear(); await b.runAccountBootstrap(f.user);
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each([false, true])('an explicit denial still invalidates readiness when its persisted marker is missing: %s', async (missing) => {
    const b = await run(); const cache = await import('@/lib/local-cache/cache');
    await cache.putCached(f.user, `blocked:${projectId}`, true);
    if (missing) await (await import('@/lib/local-cache/driver')).localCacheDriver.remove(f.user, `blocked:${projectId}`);
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ basic_ready: false, offline_ready: false });
  });
  it('normalizes a legacy running operation before an expired daily snapshot returns', async () => {
    const b = await run(); const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    const entry = (await driver.get(f.user, BOOTSTRAP_KEY))!;
    await driver.put({ ...entry, data: JSON.stringify({ ...JSON.parse(entry.data), status: 'running', progress: 94 }) });
    vi.setSystemTime(Date.now() + 86400000); vi.resetModules();
    const fresh = await import('@/lib/local-cache/bootstrap');
    expect(await fresh.getBootstrapMetadata(f.user)).toMatchObject({ status: 'partial', basic_ready: false });
    expect((await import('@/lib/local-cache/runtime-state')).getOfflineRuntime(f.user).operations.preparation).toBeUndefined();
  });
  it('redownloads a corrupted batch of the same length instead of certifying it again', async () => {
    const b = await run(); const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    const entries = await driver.listEntries(f.user, 'bootstrap:batch:items:');
    const batch = entries[0]; const rows = JSON.parse(batch.data); rows[0].comment = 'Corrupted disk value';
    await driver.put({ ...batch, data: JSON.stringify(rows) });
    expect((await b.getBootstrapMetadata(f.user)).basic_ready).toBe(false);
    f.rpc.mockClear(); await b.retryAccountBootstrap(f.user);
    expect(pages('items')).toHaveLength(1); expect((await b.getBootstrapMetadata(f.user)).basic_ready).toBe(true);
    expect(await stored(`items:${taskId}:active`)).toMatchObject([{ comment: 'Saved comment' }]);
  });
  it('checks Extended history and notifications independently while retaining Basic readiness', async () => {
    const b = await run(); await b.selectOfflineScheme(f.user, 'extended'); await again(b);
    const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    expect((await b.getBootstrapMetadata(f.user)).extended_ready).toBe(true);
    await driver.remove(f.user, 'notifications:window');
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ basic_ready: true, extended_ready: false, status: 'partial' });
    await b.retryAccountBootstrap(f.user); expect((await b.getBootstrapMetadata(f.user)).extended_ready).toBe(true);
    await driver.remove(f.user, `audit:${taskId}:90days`);
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ basic_ready: true, extended_ready: false });
  });
  it('a fully prepared cache stays ready offline and runtime preparation never persists', async () => {
    const b = await run(); vi.stubGlobal('navigator', { ...navigator, onLine: false });
    await b.runAccountBootstrap(f.user);
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ status: 'ready', basic_ready: true, progress: 100 });
    const saved = await stored(BOOTSTRAP_KEY);
    expect(['running', 'updating', 'recovering', 'syncing']).not.toContain(saved.status);
    expect(saved.started_at).toBeNull(); expect(Object.values(saved.datasets).some((s: unknown) => (s as { status: string }).status === 'loading')).toBe(false);
  });
  it('selecting an incomplete Extended scope offline persists partial, with Basic still usable', async () => {
    const b = await run(); vi.stubGlobal('navigator', { ...navigator, onLine: false });
    await b.selectOfflineScheme(f.user, 'extended');
    expect(await stored(BOOTSTRAP_KEY)).toMatchObject({ scheme: 'extended', status: 'partial', basic_ready: true,
      extended_ready: false, offline_ready: true });
    expect((await stored(BOOTSTRAP_KEY)).progress).toBeLessThan(100);
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ status: 'partial', basic_ready: true, extended_ready: false });
  });
  it('bounds the Extended final verification at 94% and settles with verified basic readiness', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const b = await run(); const normal = f.rpc.getMockImplementation()!;
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    f.rpc.mockImplementation((name, args) => name === 'get_offline_account_manifest' && args.p_scheme === 'extended' && args.p_snapshot_at
      ? { abortSignal: () => { entered(); return new Promise(() => undefined); } } : normal(name, args));
    await b.selectOfflineScheme(f.user, 'extended');
    await started;
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ status: 'updating', progress: 94, basic_ready: true, extended_ready: false });
    const pending = b.runAccountBootstrap(f.user);
    await vi.advanceTimersByTimeAsync(b.BOOTSTRAP_OPERATION_TIMEOUT_MS); await pending;
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ status: 'partial', progress: 94, basic_ready: true, extended_ready: false, lease: null, retry: { reason: 'transport' } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('manual retry recovers its own unexpired lease after storage rejected both terminal state and cleanup', async () => {
    const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    const original = driver.commitCacheBatch; let writes = 0;
    const broken = vi.spyOn(driver, 'commitCacheBatch').mockImplementation((...args) => {
      if (++writes > 1) return Promise.reject(new Error('Quota exceeded'));
      return original(...args);
    });
    const b = await import('@/lib/local-cache/bootstrap'); await b.runAccountBootstrap(f.user);
    expect((await b.getBootstrapMetadata(f.user)).status).toBe('error');
    const saved = await stored(BOOTSTRAP_KEY);
    expect(saved.lease.expires_at).toBeGreaterThan(Date.now());
    broken.mockRestore(); await b.retryAccountBootstrap(f.user, async () => true);
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ status: 'ready', progress: 100, lease: null });
  });
  it('a local commit timeout settles as a storage error, not waiting for a network that is available', async () => {
    const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    const original = driver.commitCacheBatch; let writes = 0;
    const failed = vi.spyOn(driver, 'commitCacheBatch').mockImplementation((...args) => ++writes === 2
      ? Promise.reject(Object.assign(new Error('IndexedDB timed out'), { name: 'TimeoutError' })) : original(...args));
    const b = await import('@/lib/local-cache/bootstrap'); await b.runAccountBootstrap(f.user);
    const meta = await b.getBootstrapMetadata(f.user);
    expect(meta).toMatchObject({ status: 'error', lease: null });
    expect(meta.error).toContain('Локальная операция'); expect(meta.retry?.reason).not.toBe('transport');
    failed.mockRestore(); await b.retryAccountBootstrap(f.user);
    expect((await b.getBootstrapMetadata(f.user)).basic_ready).toBe(true);
  });
  it('a cancelled initial storage write cannot publish an error after a new successful attempt', async () => {
    const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let reject!: (error: Error) => void; const oldWrite = new Promise<boolean>((_resolve, fail) => { reject = fail; });
    vi.spyOn(driver, 'commitCacheBatch').mockImplementationOnce(() => { entered(); return oldWrite; });
    const b = await import('@/lib/local-cache/bootstrap'); const old = b.runAccountBootstrap(f.user); await started;
    b.cancelAccountBootstrap(f.user); await old;
    expect((await b.getBootstrapMetadata(f.user)).status).toBe('not_started');
    await b.retryAccountBootstrap(f.user); const ready = await b.getBootstrapMetadata(f.user);
    reject(new Error('Late quota failure')); await Promise.resolve();
    expect(await b.getBootstrapMetadata(f.user)).toEqual(ready); expect(ready.basic_ready).toBe(true);
  });
  it('skips a missing optional dataset while keeping verified mandatory models ready', async () => {
    const b = await run(); const normal = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((name, args) => {
      if (name !== 'get_offline_account_manifest') return normal(name, args);
      const data = manifest(args.p_scheme === 'extended'); delete data.datasets.notifications;
      return { abortSignal: async () => ({ data, error: null }) };
    });
    await b.selectOfflineScheme(f.user, 'extended'); await again(b);
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ status: 'partial', progress: 88, offline_ready: true,
      basic_ready: true, extended_ready: false, datasets: { notifications: { status: 'skipped' } } });
    expect(pages('notifications')).toHaveLength(0);
  });
  it('settles an offline start and resumes after confirmed recovery without reloading', async () => {
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    const b = await import('@/lib/local-cache/bootstrap');
    await b.runAccountBootstrap(f.user);
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ status: 'offline_waiting', lease: null });
    expect(f.rpc).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', { onLine: true, serviceWorker: { ready: Promise.resolve({ active: {} }) } });
    await b.resumeAccountBootstrap(f.user);
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ status: 'ready', progress: 100, offline_ready: true });
  });
  it('replaces a hung attempt on retry and discards its late response', async () => {
    const normal = f.rpc.getMockImplementation()!;
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (value: unknown) => void; const hung = new Promise((resolve) => { release = resolve; });
    f.rpc.mockImplementationOnce(() => ({ abortSignal: () => { entered(); return hung; } }));
    const b = await import('@/lib/local-cache/bootstrap');
    const old = b.runAccountBootstrap(f.user); await started;
    f.rpc.mockImplementation(normal);
    await b.retryAccountBootstrap(f.user, async () => true);
    const ready = await b.getBootstrapMetadata(f.user);
    expect(ready).toMatchObject({ status: 'ready', progress: 100, lease: null });
    release({ data: { ...manifest(false), user_id: 'foreign' }, error: null }); await old;
    expect(await b.getBootstrapMetadata(f.user)).toEqual(ready);
  });
  it('settles a request that ignores AbortSignal at the deadline and permits a fresh retry', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    const normal = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementationOnce(() => ({ abortSignal: () => { entered(); return new Promise(() => undefined); } }));
    const b = await import('@/lib/local-cache/bootstrap');
    const old = b.runAccountBootstrap(f.user); await started;
    await vi.advanceTimersByTimeAsync(b.BOOTSTRAP_OPERATION_TIMEOUT_MS); await old;
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ status: 'offline_waiting', lease: null });
    f.rpc.mockImplementation(normal); await b.retryAccountBootstrap(f.user, async () => true);
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ status: 'ready', progress: 100 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels loading and unvisited datasets, releases the lease and allows retry', async () => {
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    const normal = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((name, args) => name === 'get_offline_account_page' && args.p_dataset === 'profile'
      ? { abortSignal: () => { entered(); return new Promise(() => undefined); } } : normal(name, args));
    const b = await import('@/lib/local-cache/bootstrap'); const old = b.runAccountBootstrap(f.user); await started;
    b.cancelAccountBootstrap(f.user); await old;
    const meta = await b.getBootstrapMetadata(f.user);
    expect(meta.lease).toBeNull(); expect(meta.status).toBe('partial');
    expect(Object.values(meta.datasets).every((state) => state.status === 'cancelled')).toBe(true);
    f.rpc.mockImplementation(normal); await b.retryAccountBootstrap(f.user, async () => true);
    expect((await b.getBootstrapMetadata(f.user)).status).toBe('ready');
  });
  it('keeps ready during unchanged background revalidation and settles Extended at 100%', async () => {
    const b = await run(); await advance(b);
    const transitions: string[] = [];
    const stop = b.subscribeBootstrap(() => { void b.getBootstrapMetadata(f.user).then((meta) => transitions.push(meta.status)); });
    await b.runAccountBootstrap(f.user, true); stop();
    expect(transitions.length).toBeGreaterThan(0); expect(transitions.every((status) => status === 'ready')).toBe(true);
    await b.selectOfflineScheme(f.user, 'extended'); await again(b);
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ status: 'ready', progress: 100, basic_ready: true, extended_ready: true });
  });
  it.each(['40001', 'PT409'])('bounds 100 forced calls after %s and persists exponential backoff across tabs/reload', async (code) => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    f.failure = { dataset: 'profile', error: { code, message: 'offline snapshot changed' } };
    let b = await import('@/lib/local-cache/bootstrap');
    for (let i = 0; i < 100; i++) await b.runAccountBootstrap(f.user, true);
    expect(pages()).toHaveLength(3);
    expect(f.rpc.mock.calls.filter(([name]) => name === 'get_offline_account_manifest')).toHaveLength(3);
    const first = await b.getBootstrapMetadata(f.user);
    expect(first.retry).toEqual({ failures: 1, next_retry_at: Date.now() + 30_000 });
    vi.resetModules(); b = await import('@/lib/local-cache/bootstrap');
    await b.runAccountBootstrap(f.user, true);
    expect(pages()).toHaveLength(3);
    await advance(b); await b.runAccountBootstrap(f.user, true);
    expect(pages()).toHaveLength(6);
    expect((await b.getBootstrapMetadata(f.user)).retry).toEqual({ failures: 2, next_retry_at: Date.now() + 60_000 });
  });
  it('forwards the exact microsecond snapshot to every page and verification manifest', async () => {
    const original = f.rpc.getMockImplementation()!;
    const snapshot = stamp.replace(/\.\d{3}Z$/, '.123456+00:00');
    f.rpc.mockImplementation((name, args) => name === 'get_offline_account_manifest'
      ? { abortSignal: async () => ({ data: { ...manifest(false), snapshot_at: snapshot }, error: null }) }
      : original(name, args));
    const b = await run();
    expect((await b.getBootstrapMetadata(f.user)).offline_ready).toBe(true);
    expect(pages().every(([, args]) => args.p_snapshot_at === snapshot)).toBe(true);
    const manifests = f.rpc.mock.calls.filter(([name]) => name === 'get_offline_account_manifest');
    expect(manifests).toHaveLength(2);
    expect(manifests[0][1]).not.toHaveProperty('p_snapshot_at');
    expect(manifests[1][1].p_snapshot_at).toBe(snapshot);
  });
  it('restarts once after a real items revision change and commits the new rows', async () => {
    const original = f.rpc.getMockImplementation()!;
    let changed = false;
    f.rpc.mockImplementation((name, args) => {
      if (name === 'get_offline_account_page' && args.p_dataset === 'items' && !changed) {
        changed = true; f.rows.items[0] = { ...(f.rows.items[0] as object), comment: 'Concurrent edit' };
        return { abortSignal: async () => ({ data: null, error: { code: 'PT409', message: 'offline snapshot changed' } }) };
      }
      return original(name, args);
    });
    const b = await run();
    expect(pages('items')).toHaveLength(2);
    expect(f.rpc.mock.calls.filter(([name]) => name === 'get_offline_account_manifest')).toHaveLength(3);
    expect(await stored(`items:${taskId}:active`)).toMatchObject([{ comment: 'Concurrent edit' }]);
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ offline_ready: true, retry: null });
  });
  it('keeps two of three Web Lock callers passive without queuing duplicate RPCs', async () => {
    const original = f.rpc.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    f.rpc.mockImplementation((name, args) => name === 'get_offline_account_manifest'
      ? { abortSignal: async () => { entered(); await gate; return { data: manifest(false), error: null }; } }
      : original(name, args));
    let locked = false; let owners = 0; let peak = 0;
    const request = vi.fn(async (_name: string, options: { ifAvailable: boolean }, callback: (lock: object | null) => Promise<void>) => {
      expect(options.ifAvailable).toBe(true);
      if (locked) return callback(null);
      locked = true; peak = Math.max(peak, ++owners);
      try { await callback({}); } finally { owners--; locked = false; }
    });
    vi.stubGlobal('navigator', { locks: { request } });
    const a = await import('@/lib/local-cache/bootstrap'); vi.resetModules();
    const b = await import('@/lib/local-cache/bootstrap'); vi.resetModules();
    const c = await import('@/lib/local-cache/bootstrap');
    const owner = a.runAccountBootstrap(f.user, true, async () => true); await started;
    expect(await Promise.all([b.runAccountBootstrap(f.user, true), c.runAccountBootstrap(f.user, true)])).toEqual(['busy', 'busy']);
    expect(f.rpc).toHaveBeenCalledTimes(1);
    release(); await owner;
    expect(peak).toBe(1); expect(pages('items')).toHaveLength(1);
    await c.runAccountBootstrap(f.user, true);
    expect(f.rpc.mock.calls.filter(([name]) => name === 'get_offline_account_manifest')).toHaveLength(2);
  });
  it('prevents an expired lease owner from saving or releasing the replacement owner', async () => {
    let releaseA!: () => void; let releaseB!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; }); const gateB = new Promise<void>((r) => { releaseB = r; });
    let enteredA!: () => void; let enteredB!: () => void;
    const startedA = new Promise<void>((r) => { enteredA = r; }); const startedB = new Promise<void>((r) => { enteredB = r; });
    let calls = 0; const original = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((name, args) => name === 'get_offline_account_manifest' && calls++ < 2
      ? { abortSignal: async () => { const first = calls === 1; (first ? enteredA : enteredB)(); await (first ? gateA : gateB); return { data: manifest(false), error: null }; } }
      : original(name, args));
    const a = await import('@/lib/local-cache/bootstrap'); vi.resetModules();
    const b = await import('@/lib/local-cache/bootstrap'); vi.resetModules();
    const c = await import('@/lib/local-cache/bootstrap');
    const old = a.runAccountBootstrap(f.user, true); await startedA;
    vi.setSystemTime(Date.now() + 45_001);
    const replacement = b.runAccountBootstrap(f.user, true); await startedB;
    const owner = (await b.getBootstrapMetadata(f.user)).lease!.owner;
    releaseA(); await old;
    expect((await b.getBootstrapMetadata(f.user)).lease!.owner).toBe(owner);
    await c.runAccountBootstrap(f.user, true); expect(pages()).toHaveLength(0);
    releaseB(); await replacement;
    expect((await b.getBootstrapMetadata(f.user)).offline_ready).toBe(true);
    expect(pages('items')).toHaveLength(1);
  });
  it('keeps a live foreign lease and its CAS baseline intact when another tab retries', async () => {
    const owner = await import('@/lib/local-cache/bootstrap'); const normal = f.rpc.getMockImplementation()!;
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    f.rpc.mockImplementation((name, args) => name === 'get_offline_account_manifest'
      ? { abortSignal: async () => { entered(); await held; return { data: manifest(false), error: null }; } } : normal(name, args));
    const first = owner.runAccountBootstrap(f.user, true); await started;
    const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    const before = await driver.get(f.user, BOOTSTRAP_KEY);
    vi.resetModules(); const peer = await import('@/lib/local-cache/bootstrap');
    expect(await peer.retryAccountBootstrap(f.user, async () => true)).toBe('busy');
    expect(await driver.get(f.user, BOOTSTRAP_KEY)).toEqual(before);
    release(); await first;
    expect(await owner.getBootstrapMetadata(f.user)).toMatchObject({ status: 'ready', offline_ready: true, lease: null });
  });
  it('defaults to basic and commits every required dataset including archives, templates, members and current-day audit', async () => {
    const b = await run(); const meta = await b.getBootstrapMetadata(f.user);
    expect(meta).toMatchObject({ scheme: 'basic', status: 'ready', offline_ready: true, basic_ready: true, extended_ready: false, progress: 100 });
    expect(Object.keys(meta.datasets).sort()).toEqual([...BASIC_DATASETS].sort());
    expect(await stored('projects:archived')).toMatchObject([{ id: archiveId }]);
    expect(await stored(`items:${archivedTaskId}:archived`)).toMatchObject([{ is_archived: true }]);
    expect(await stored(`template-items:${templateId}`)).toMatchObject([{ title: 'Template content' }]);
    expect(await stored(`members:${projectId}`)).toMatchObject([{ profile: { display_name: 'Offline user' } }]);
    expect(await stored(`daily-audit:${projectId}:${meta.manifest!.day_start}`)).toHaveLength(1);
    expect(pages('history')).toHaveLength(0);
  });
  it('normalizes the real Postgres +00:00 day boundary and expires readiness at the UTC+3 rollover', async () => {
    const original = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((name, args) => {
      if (name !== 'get_offline_account_manifest') return original(name, args);
      return { abortSignal: async () => ({ data: { ...manifest(false), day_start: manifest(false).day_start.replace('.000Z', '+00:00') }, error: null }) };
    });
    const b = await run(); const m = await b.getBootstrapMetadata(f.user);
    expect(m.offline_ready).toBe(true);
    expect(m.manifest!.day_start).toMatch(/\.000Z$/);
    expect(await stored(`daily-audit:${projectId}:${m.manifest!.day_start}`)).toHaveLength(1);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 86400000);
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ offline_ready: false, basic_ready: false, status: 'partial', datasets: { daily_audit: { status: 'pending', offset: 0 } } });
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    await b.selectOfflineScheme(f.user, 'extended'); await b.selectOfflineScheme(f.user, 'basic');
    expect((await b.getBootstrapMetadata(f.user)).offline_ready).toBe(false);
  });
  it('does not report readiness for a missing dataset, incomplete page, failed write, or missing assets', async () => {
    f.failure = { dataset: 'template_items', error: transport };
    let b = await run(); expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ offline_ready: false, status: 'offline_waiting' });
    f.failure = null;
    const normal = f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation((name, args) => name === 'get_offline_account_page' && args.p_dataset === 'template_items'
      ? { abortSignal: async () => ({ data: { revision: revision('template_items'), total: 1, offset: 0, rows: [] }, error: null }) }
      : normal(name, args));
    b = await run(); expect((await b.getBootstrapMetadata(f.user)).offline_ready).toBe(false);
    f.rpc.mockImplementation((name, args) => {
      if (name !== 'get_offline_account_manifest') return normal(name, args);
      const missing = manifest(false); delete missing.datasets.template_items;
      return { abortSignal: async () => ({ data: missing, error: null }) };
    });
    b = await run(); expect((await b.getBootstrapMetadata(f.user)).offline_ready).toBe(false);
    f.rpc.mockImplementation(normal);
    const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    const original = driver.commitCacheBatch;
    vi.spyOn(driver, 'commitCacheBatch').mockImplementation(async (user, batch, remove, guards) => {
      if (batch.some((e) => e.key === 'templates')) throw new Error('Quota exceeded');
      return original(user, batch, remove, guards);
    });
    b = await run(); expect((await b.getBootstrapMetadata(f.user)).offline_ready).toBe(false);
    vi.restoreAllMocks();
    vi.stubGlobal('caches', { match: async () => null });
    b = await run(); expect((await b.getBootstrapMetadata(f.user)).offline_ready).toBe(false);
  });
  it('resumes acknowledged batches after reload and skips unchanged datasets on refresh', async () => {
    const base = f.rows.items[0] as Record<string, unknown>;
    f.rows.items = Array.from({ length: 1001 }, (_, i) => ({ ...base, id: `item-${i}` }));
    f.failure = { dataset: 'items', offset: 500, error: transport };
    let b = await run(); expect((await b.getBootstrapMetadata(f.user)).datasets.items?.offset).toBe(500);
    f.failure = null; f.rpc.mockClear(); vi.resetModules(); b = await run();
    expect(pages('items').map(([, args]) => args.p_offset)).toEqual([500, 1000]);
    expect((await b.getBootstrapMetadata(f.user)).offline_ready).toBe(true);
    f.rpc.mockClear(); await run(); expect(pages()).toHaveLength(0);
  });
  it('reports a failed first storage write instead of leaving readiness unstarted', async () => {
    const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    vi.spyOn(driver, 'commitCacheBatch').mockRejectedValue(new Error('Quota exceeded'));
    const b = await run();
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ status: 'error', offline_ready: false, lease: null });
    expect(pages()).toHaveLength(0);
    vi.restoreAllMocks(); await run();
    expect((await b.getBootstrapMetadata(f.user)).offline_ready).toBe(true);
  });
  it('refreshes only a changed batch and takes over an expired cross-tab lease', async () => {
    const base = f.rows.items[0] as Record<string, unknown>;
    f.rows.items = Array.from({ length: 1001 }, (_, i) => ({ ...base, id: `item-${i}` }));
    const b = await run();
    f.rows.items[700] = { ...(f.rows.items[700] as object), comment: 'Changed' }; f.rpc.mockClear();
    const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    const e = (await driver.get(f.user, BOOTSTRAP_KEY))!;
    const interrupted = { ...JSON.parse(e.data), status: 'running', lease: { owner: 'closed-tab', expires_at: Date.now() - 1 } };
    await driver.put({ ...e, data: JSON.stringify(interrupted) });
    await again(b);
    expect(pages('items').map(([, args]) => args.p_offset)).toEqual([500]);
    expect((await b.getBootstrapMetadata(f.user)).offline_ready).toBe(true);
  });
  it('does not overwrite an outbox chain or a newer confirmed item when refreshing', async () => {
    const b = await run(); const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    await driver.enqueue({ operation_id: 'pending-chain', user_id: f.user, project_id: projectId, task_id: taskId,
      task_item_id: itemId, type: 'set_task_item_percentage', payload: { percentage: 70 }, created_at: stamp, status: 'pending' });
    const entry = (await driver.get(f.user, `items:${taskId}:active`))!;
    await driver.put({ ...entry, data: JSON.stringify([{ ...(f.rows.items[0] as object), sync_version: 6, percentage: 60 }]) });
    await again(b);
    expect(await stored(`items:${taskId}:active`)).toMatchObject([{ sync_version: 6, percentage: 60 }]);
    expect(await driver.listPending(f.user)).toMatchObject([{ operation_id: 'pending-chain', expected_version: 4 }]);
  });
  it('keeps extended offline pagination bounded and never falls back after a known 403', async () => {
    const b = await run(); await b.selectOfflineScheme(f.user, 'extended'); await again(b);
    const notifications = await import('@/features/notifications/notifications');
    expect(await notifications.fetchNotificationPage(1, 0)).toMatchObject({ offline: true, limited: true, hasMore: false, rows: [{ title: 'Notice' }] });
    expect((await notifications.fetchNotificationPage(100, 100)).rows).toEqual([]);
    const projects = await import('@/features/projects/projects');
    expect(await projects.listTaskAudit(projectId, taskId)).toHaveLength(1);
    (await import('@/lib/connectivity/state')).reportConnectivitySuccess();
    f.from.mockReturnValue({ select: () => ({ order: () => ({ range: async () => ({ data: null, error: { status: 403, message: 'Denied' } }) }) }) });
    await expect(notifications.fetchNotificationPage()).rejects.toMatchObject({ status: 403 });
    expect(await stored('notifications:window')).toBeNull();
  });
  it('basic → extended keeps verified basic models usable without claiming failed optional data is ready', async () => {
    const b = await run(); f.failure = { dataset: 'history', error: transport }; f.rpc.mockClear();
    await b.selectOfflineScheme(f.user, 'extended'); await again(b);
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ scheme: 'extended', status: 'partial', progress: 88,
      offline_ready: true, basic_ready: true, extended_ready: false, datasets: { history: { status: 'error' } } });
    expect(pages('items')).toHaveLength(0);
    f.failure = null; await run(); expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ status: 'ready', extended_ready: true });
    expect(await stored(`audit:${taskId}:90days`)).toHaveLength(1);
    vi.stubGlobal('navigator', { ...navigator, onLine: false }); f.rpc.mockClear();
    await b.selectOfflineScheme(f.user, 'basic');
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ scheme: 'basic', offline_ready: true });
    expect(f.rpc).not.toHaveBeenCalled();
    await b.runAccountBootstrap(f.user, true);
    expect(await stored('notifications:window')).toBeTruthy(); // safely retained
  });
  it('blocks revoked resources even when a later dataset fails and never mixes users', async () => {
    const b = await run();
    f.rows.projects = []; f.rows.tasks = []; f.rows.roles = []; f.failure = { dataset: 'items', error: transport };
    f.rows.items.push({ id: 'changed' }); await run();
    expect(await stored(`blocked:${projectId}`)).toBe(true);
    expect(await stored(`blocked-task:${taskId}`)).toBe(true);
    const projects = await import('@/features/projects/projects');
    await expect(projects.getProject(projectId)).rejects.toMatchObject(transport);
    const driver = (await import('@/lib/local-cache/driver.web')).localCacheDriver;
    expect(await driver.get('user-b', `project:${projectId}`)).toBeNull();
    f.user = 'user-b'; expect(await b.getBootstrapMetadata('user-b')).toMatchObject(initialBootstrap('user-b'));
  });
  it('survives a missing saved batch, refuses a foreign manifest and serializes duplicate runners', async () => {
    const b = await run(); const driver = (await import('@/lib/local-cache/driver.web')).localCacheDriver;
    const batches = await driver.listEntries(f.user, 'bootstrap:batch:items:');
    await driver.remove(f.user, batches[0].key); f.rpc.mockClear();
    await advance(b);
    await Promise.all([b.runAccountBootstrap(f.user, true), b.runAccountBootstrap(f.user, true)]);
    expect(pages('items')).toHaveLength(1);
    f.rpc.mockImplementation(() => ({ abortSignal: async () => ({ data: { ...manifest(false), user_id: 'foreign' }, error: null }) }));
    await run(); expect((await b.getBootstrapMetadata(f.user)).offline_ready).toBe(false);
    expect(await driver.get(f.user, BOOTSTRAP_KEY)).toBeTruthy();
  });
  it('uses the IndexedDB lease across independent tab runners', async () => {
    const first = await import('@/lib/local-cache/bootstrap');
    vi.resetModules();
    const second = await import('@/lib/local-cache/bootstrap');
    await Promise.all([first.runAccountBootstrap(f.user, true), second.runAccountBootstrap(f.user, true)]);
    expect(pages('items')).toHaveLength(1);
    expect((await second.getBootstrapMetadata(f.user)).offline_ready).toBe(true);
  });
  it('applies downgraded permissions before a later dataset failure', async () => {
    await run(); const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    const entry = (await driver.get(f.user, `task-role:${taskId}`))!;
    await driver.put({ ...entry, key: `task-overrides:${taskId}`, data: JSON.stringify([{ user_id: f.user, role_override: 'editor' }]) });
    f.rows.projects[0] = { ...(f.rows.projects[0] as object), role: 'viewer' };
    f.rows.roles[0] = { task_id: taskId, role: 'viewer' };
    f.rows.items.push({ id: 'changed' }); f.failure = { dataset: 'items', error: transport };
    const b = await run();
    expect((await b.getBootstrapMetadata(f.user)).offline_ready).toBe(false);
    expect(await stored(`task-role:${taskId}`)).toBe('viewer');
    expect(await stored(`task-overrides:${taskId}`)).toBeNull();
  });
  it('reads every basic page repository after the network is unavailable, with unchanged progress semantics', async () => {
    await run(); const projects = await import('@/features/projects/projects');
    expect(await projects.listProjects()).toMatchObject([{ id: projectId }]);
    expect(await projects.getProject(archiveId)).toMatchObject({ status: 'archived' });
    expect(await projects.listProjectMembers(projectId)).toHaveLength(1);
    expect(await projects.getTask(taskId, projectId)).toMatchObject({ title: 'Active stage' });
    expect(await projects.listTaskItems(taskId)).toMatchObject([{ comment: 'Saved comment' }]);
    expect(await projects.listTaskTemplates()).toMatchObject([{ name: 'Template' }]);
    expect(await projects.listTaskTemplateItems(templateId)).toHaveLength(1);
    expect(await projects.listTaskDailyProgress(projectId, taskId)).toMatchObject([{ oldPercentage: 20, newPercentage: 40 }]);
    expect((await projects.listProjectDailyProgress(projectId)).entries).toMatchObject([{ oldPercentage: 20, newPercentage: 40 }]);
    expect(await projects.listOwnedProjects()).toHaveLength(2);
    expect(await stored('profile:self')).toMatchObject({ display_name: 'Offline user' });
  });
});
