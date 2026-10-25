import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), subscribe: vi.fn(), rows: [] as { id: string; is_read: boolean; created_at: string }[] }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { from: f.from, rpc: f.rpc, auth: {
  getSession: async () => ({ data: { session: { user: { id: 'a' }, expires_at: Date.now() / 1000 + 3600 } }, error: null }),
} } }));
vi.mock('@/lib/supabase/realtime', () => ({ subscribeTable: f.subscribe }));
vi.mock('@/lib/local-cache/driver', async () => import('@/lib/local-cache/driver.web'));
const queries: { columns: string; head: boolean; read: boolean | undefined }[] = [];
it('combined filters are sent before the stable page range; filtered reads never truncate the Extended cache', async () => {
  await seedWindow();
  const n = await import('@/features/notifications/notifications');
  const calls: unknown[][] = [];
  const query = { select: () => query, eq: (...args: unknown[]) => { calls.push(['eq', ...args]); return query; },
    in: (...args: unknown[]) => { calls.push(['in', ...args]); return query; }, or: (...args: unknown[]) => { calls.push(['or', ...args]); return query; },
    gte: (...args: unknown[]) => { calls.push(['gte', ...args]); return query; }, lte: (...args: unknown[]) => { calls.push(['lte', ...args]); return query; },
    order: (...args: unknown[]) => { calls.push(['order', ...args]); return query; }, range: (...args: unknown[]) => { calls.push(['range', ...args]); return query; },
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve) };
  f.from.mockReturnValue(query);
  await n.fetchNotificationPage(20, 40, { projectIds: ['p', 'p2'], taskIds: ['t', 't2'], from: '2026-10-15T12:30:00Z', to: '2026-10-16T12:30:00Z', actions: ['deadline:overdue', 'task_assigned'], reads: ['unread'] });
  expect(calls).toEqual([
    ['in', 'project_id', ['p', 'p2']], ['in', 'task_id', ['t', 't2']], ['gte', 'created_at', '2026-10-15T12:30:00Z'], ['lte', 'created_at', '2026-10-16T12:30:00Z'],
    ['eq', 'is_read', false], ['or', 'type.in.(task_assigned),data->>deadline_event.in.(overdue)'], ['order', 'created_at', { ascending: false }], ['order', 'id', { ascending: false }], ['range', 40, 59],
  ]);
  const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
  expect(JSON.parse((await driver.get('a', 'notifications:window'))!.data).rows).toHaveLength(3);
});
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); queries.length = 0;
  await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase('tasktrace-local-cache'); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
  vi.stubGlobal('navigator', { onLine: true }); (await import('@/lib/local-cache/read-freshness')).setReadAccount('a');
  f.rows = [{ id: 'one', is_read: false, created_at: '2026-10-07' }, { id: 'two', is_read: false, created_at: '2026-10-06' }, { id: 'read', is_read: true, created_at: '2026-10-05' }];
  f.from.mockImplementation((table: string) => {
    expect(table).toBe('notifications'); const state = { columns: '', head: false, read: undefined as boolean | undefined };
    const query = { select: (columns: string, options?: { head?: boolean }) => { state.columns = columns; state.head = options?.head ?? false; return query; },
      eq: (_key: string, read: boolean) => { state.read = read; return query; }, order: () => query, range: () => query,
      then: (resolve: (value: unknown) => unknown) => {
        queries.push({ ...state }); const rows = f.rows.filter((r) => state.read === undefined || r.is_read === state.read);
        return Promise.resolve({ data: state.head ? null : rows.map((r) => ({ ...r })), count: rows.length, error: null }).then(resolve);
      } };
    return query;
  });
  f.rpc.mockImplementation(async (name, args) => {
    if (name === 'get_client_operation_context') return { data: { protocol_version: 3, fingerprint_version: 1,
      generation: '11111111-1111-4111-8111-111111111111', epoch: 1, admit_until: '2030-01-02', replay_until: '2030-04-02' }, error: null, status: 200 };
    if (name === 'execute_client_mutation' || name === 'execute_client_mutation_v3') { name = args.p_name; args = args.p_args; }
    for (const row of f.rows) if (name === 'mark_all_notifications_read' || row.id === args.p_notification_id) row.is_read = true;
    return { data: null, error: null, status: 200 };
  });
  f.subscribe.mockReturnValue(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function seedWindow(age = 0) {
  const driver = (await import('@/lib/local-cache/driver')).localCacheDriver;
  await driver.put({ user_id: 'a', key: 'notifications:window', data: JSON.stringify({ rows: f.rows, read_limit: 100 }), last_synced_at: new Date(Date.now() - age).toISOString(), schema_version: 1 });
}
it('a stale notification window cannot turn badge refresh into SELECT rows', async () => {
  await seedWindow(60001); const n = await import('@/features/notifications/notifications');
  expect(await n.fetchUnreadCount()).toBe(2); expect(queries).toEqual([{ columns: 'id', head: true, read: false }]);
  for (let i = 0; i < 10; i++) expect(await n.fetchUnreadCount()).toBe(2);
  expect(queries).toHaveLength(1);
});
it('opening Notifications still downloads all unread and the bounded read window', async () => {
  const n = await import('@/features/notifications/notifications'); expect((await n.fetchNotificationPage()).rows).toHaveLength(3);
  expect(queries).toEqual([{ columns: '*', head: false, read: false }, { columns: '*', head: false, read: true }]);
});
it('a notice moving from unread to read between the two window queries appears once with the acknowledged state', async () => {
  f.from.mockImplementation(() => {
    let read = false;
    const query = { select: () => query, eq: (_key: string, value: boolean) => { read = value; return query; }, order: () => query, range: () => query,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [{ id: 'moving', created_at: '2026-10-16', is_read: read }], error: null }).then(resolve) };
    return query;
  });
  const n = await import('@/features/notifications/notifications');
  expect((await n.fetchNotificationPage()).rows).toMatchObject([{ id: 'moving', is_read: true }]);
  expect((await n.fetchNotificationPage()).rows).toHaveLength(1);
});
it('offline combined filtering paginates the saved window without downloading or replacing it', async () => {
  const rows = [
    { id: 'new', is_read: false, project_id: 'p', task_id: 't', created_at: '2026-10-16T12:30:00Z', type: 'task_item_changed', data: { deadline_event: 'overdue' } },
    { id: 'other', is_read: false, project_id: 'q', task_id: 't', created_at: '2026-10-16T12:20:00Z', type: 'task_item_changed', data: { deadline_event: 'overdue' } },
    { id: 'old', is_read: false, project_id: 'p', task_id: 't', created_at: '2026-10-16T12:10:00Z', type: 'task_item_changed', data: { deadline_event: 'overdue' } },
  ];
  f.rows = rows; await seedWindow(); vi.stubGlobal('navigator', { onLine: false });
  const n = await import('@/features/notifications/notifications');
  const filters = { projectId: 'p', taskId: 't', action: 'deadline:overdue', read: 'unread' as const, from: '2026-10-16T12:00:00Z', to: '2026-10-16T13:00:00Z' };
  expect(await n.fetchNotificationPage(1, 0, filters)).toMatchObject({ offline: true, hasMore: true, rows: [{ id: 'new' }] });
  expect(await n.fetchNotificationPage(1, 1, filters)).toMatchObject({ offline: true, hasMore: false, rows: [{ id: 'old' }] });
  expect(f.from).not.toHaveBeenCalled();
});
it.each(['one', 'all'])('mark %s invalidates both models and badge converges using only HEAD/count', async (mode) => {
  await seedWindow(); const n = await import('@/features/notifications/notifications'); const r = await import('@/lib/local-cache/read-freshness');
  expect(await n.fetchUnreadCount()).toBe(2); queries.length = 0;
  if (mode === 'one') await n.markAsRead('one'); else await n.markAllAsRead();
  expect(r.readInvalidation('a', 'notifications:window').kind).toBe('data'); expect(r.readInvalidation('a', 'notifications:unread-count').kind).toBe('data');
  await n.fetchUnreadCount(); await vi.waitFor(async () => expect(await n.fetchUnreadCount()).toBe(mode === 'one' ? 1 : 0));
  expect(queries).toEqual([{ columns: 'id', head: true, read: false }]);
});
it('a burst of realtime and read-model broadcasts refreshes the badge once without a window/count loop', async () => {
  await seedWindow(); const n = await import('@/features/notifications/notifications'); const r = await import('@/lib/local-cache/read-freshness');
  expect(await n.fetchUnreadCount()).toBe(2); queries.length = 0; f.rows[0].is_read = true;
  const seen: number[] = []; const refresh = vi.fn(() => { void n.fetchUnreadCount().then((value) => seen.push(value)); });
  const cleanup = n.subscribeToNotifications('a', refresh);
  try {
    const onEvent = f.subscribe.mock.calls[0][1].onEvent;
    for (let i = 0; i < 20; i++) { await r.invalidateRealtimeModels('a', 'notifications', { userId: 'a' }); onEvent({ table: 'notifications', eventType: 'UPDATE' }); }
    const models = await import('@/lib/local-cache/read-model-events');
    for (let i = 0; i < 10; i++) models.announceReadModelCommit('a', ['notifications:window'], 'read');
    await vi.waitFor(() => expect(seen).toContain(1));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(queries).toEqual([{ columns: 'id', head: true, read: false }]); expect(refresh.mock.calls.length).toBeLessThanOrEqual(2);
  } finally { cleanup(); }
});
it('an older Extended window still supplies the offline badge without HTTP or materializing rows', async () => {
  await seedWindow(60001); vi.stubGlobal('navigator', { onLine: false }); const n = await import('@/features/notifications/notifications');
  expect(await n.fetchUnreadCount()).toBe(2); expect(f.from).not.toHaveBeenCalled();
});
it('offline window fallback cannot bypass an authoritative count or global ACL denial', async () => {
  await seedWindow(); const r = await import('@/lib/local-cache/read-freshness'); await r.invalidateReadModels('a', undefined, 'access');
  vi.stubGlobal('navigator', { onLine: false }); const n = await import('@/features/notifications/notifications');
  await expect(n.fetchUnreadCount()).rejects.toThrow(); expect(f.from).not.toHaveBeenCalled();
});
it('a global ACL change during notification pagination rejects the late protected rows', async () => {
  await seedWindow(); const n = await import('@/features/notifications/notifications'); const r = await import('@/lib/local-cache/read-freshness');
  const query = { select: () => query, order: () => query, range: () => query, then: async (resolve: (value: unknown) => unknown) => {
    await r.invalidateReadModels('a', undefined, 'access'); return resolve({ data: f.rows, error: null });
  } };
  f.from.mockReturnValue(query); await expect(n.fetchNotificationPage(100, 100)).rejects.toThrow('Доступ изменился');
});
