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
  return { schema_version: 1, user_id: f.user, generated_at: stamp, day_start: new Date(utc3.getTime() - 3 * 3600000).toISOString(),
    history_start: new Date(Date.now() - 90 * 86400000).toISOString(), datasets: Object.fromEntries((extended ? [...BASIC_DATASETS, ...EXTENDED_DATASETS] : BASIC_DATASETS)
      .map((name) => [name, { count: f.rows[name].length, revision: revision(name), pages: Array.from({ length: Math.ceil(f.rows[name].length / 500) }, (_, page) =>
        createHash('md5').update(JSON.stringify(f.rows[name].slice(page * 500, page * 500 + 500))).digest('hex')) }])) };
}
beforeEach(async () => {
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

async function run() { const b = await import('@/lib/local-cache/bootstrap'); await b.runAccountBootstrap(f.user, true); return b; }
async function stored(key: string) { const d = (await import('@/lib/local-cache/driver.web')).localCacheDriver; const e = await d.get(f.user, key); return e ? JSON.parse(e.data) : null; }
function pages(name?: string) { return f.rpc.mock.calls.filter(([rpc, args]) => rpc === 'get_offline_account_page' && (!name || args.p_dataset === name)); }

describe('account bootstrap', () => {
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
    vi.stubGlobal('navigator', { onLine: false });
    await b.selectOfflineScheme(f.user, 'extended'); await b.selectOfflineScheme(f.user, 'basic');
    expect((await b.getBootstrapMetadata(f.user)).offline_ready).toBe(false);
  });
  it('does not report readiness for a missing dataset, incomplete page, failed write, or missing assets', async () => {
    f.failure = { dataset: 'template_items', error: transport };
    let b = await run(); expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ offline_ready: false, status: 'partial' });
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
    await b.runAccountBootstrap(f.user, true);
    expect(pages('items').map(([, args]) => args.p_offset)).toEqual([500]);
    expect((await b.getBootstrapMetadata(f.user)).offline_ready).toBe(true);
  });
  it('does not overwrite an outbox chain or a newer confirmed item when refreshing', async () => {
    const b = await run(); const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
    await driver.enqueue({ operation_id: 'pending-chain', user_id: f.user, project_id: projectId, task_id: taskId,
      task_item_id: itemId, type: 'set_task_item_percentage', payload: { percentage: 70 }, created_at: stamp, status: 'pending' });
    const entry = (await driver.get(f.user, `items:${taskId}:active`))!;
    await driver.put({ ...entry, data: JSON.stringify([{ ...(f.rows.items[0] as object), sync_version: 6, percentage: 60 }]) });
    await b.runAccountBootstrap(f.user, true);
    expect(await stored(`items:${taskId}:active`)).toMatchObject([{ sync_version: 6, percentage: 60 }]);
    expect(await driver.listPending(f.user)).toMatchObject([{ operation_id: 'pending-chain', expected_version: 4 }]);
  });
  it('keeps extended offline pagination bounded and never falls back after a known 403', async () => {
    const b = await run(); await b.selectOfflineScheme(f.user, 'extended'); await b.runAccountBootstrap(f.user, true);
    const notifications = await import('@/features/notifications/notifications');
    expect(await notifications.fetchNotificationPage(1, 0)).toMatchObject({ offline: true, limited: true, hasMore: false, rows: [{ title: 'Notice' }] });
    expect((await notifications.fetchNotificationPage(100, 100)).rows).toEqual([]);
    const projects = await import('@/features/projects/projects');
    expect(await projects.listTaskAudit(projectId, taskId)).toHaveLength(1);
    f.from.mockReturnValue({ select: () => ({ order: () => ({ range: async () => ({ data: null, error: { status: 403, message: 'Denied' } }) }) }) });
    await expect(notifications.fetchNotificationPage()).rejects.toMatchObject({ status: 403 });
    expect(await stored('notifications:window')).toBeNull();
  });
  it('basic → extended starts a background download, persists selection and changes readiness requirements', async () => {
    const b = await run(); f.failure = { dataset: 'history', error: transport }; f.rpc.mockClear();
    await b.selectOfflineScheme(f.user, 'extended'); await b.runAccountBootstrap(f.user, true);
    expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ scheme: 'extended', offline_ready: false, basic_ready: true });
    expect(pages('items')).toHaveLength(0);
    f.failure = null; await run(); expect(await b.getBootstrapMetadata(f.user)).toMatchObject({ status: 'ready', extended_ready: true });
    expect(await stored(`audit:${taskId}:90days`)).toHaveLength(1);
    vi.stubGlobal('navigator', { onLine: false }); f.rpc.mockClear();
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
