import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), subscribe: vi.fn(), rows: [] as { id: string; is_read: boolean; created_at: string }[] }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { from: f.from, rpc: f.rpc, auth: {
  getSession: async () => ({ data: { session: { user: { id: 'a' }, expires_at: Date.now() / 1000 + 3600 } }, error: null }),
} } }));
vi.mock('@/lib/supabase/realtime', () => ({ subscribeTable: f.subscribe }));
vi.mock('@/lib/local-cache/driver', async () => import('@/lib/local-cache/driver.web'));
const queries: { columns: string; head: boolean; read: boolean | undefined }[] = [];
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
  f.rpc.mockImplementation(async (name, args) => { for (const row of f.rows) if (name === 'mark_all_notifications_read' || row.id === args.p_notification_id) row.is_read = true; return { error: null }; });
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
