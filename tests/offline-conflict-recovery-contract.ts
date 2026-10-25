import 'fake-indexeddb/auto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalCacheDriver, OfflineOperation, ReconciledItem } from '@/lib/local-cache/types';

const f = vi.hoisted(() => ({
  native: false, db: null as DatabaseSync | null, user: 'user-a', epoch: 1,
  items: new Map<string, ReconciledItem>(), receipts: new Map<string, unknown>(),
  calls: [] as { id: string; generation?: string; epoch?: number; expected: number; item: string }[],
  effects: 0, loseAck: false, failAck: false, failAckTransaction: false, terminal: null as string | null,
  held: null as null | Promise<void>, holdAfterCommit: false, terminalCalls: 0,
  beforeRebase: null as null | (() => Promise<void>),
}));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: async () => {
  const db = f.db!;
  const tx = {
    execAsync: async (sql: string) => { db.exec(sql); },
    getFirstAsync: async (sql: string, params: (string | number | null)[] = []) => db.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql: string, params: (string | number | null)[] = []) => db.prepare(sql).all(...params),
    runAsync: async (sql: string, params: (string | number | null)[] = []) => {
      if (f.failAckTransaction && sql.startsWith('UPDATE pending_operations SET expected_version')) throw new Error('Synthetic failure inside ACK transaction');
      return { lastInsertRowId: Number(db.prepare(sql).run(...params).lastInsertRowid) };
    },
  };
  return { ...tx, withExclusiveTransactionAsync: async (work: (value: typeof tx) => Promise<void>) => {
    db.exec('BEGIN IMMEDIATE');
    try { await work(tx); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
} }));
vi.mock('@/lib/local-cache/driver', async () => {
  const load = async () => (f.native ? await import('@/lib/local-cache/driver.native') : await import('@/lib/local-cache/driver.web')).localCacheDriver;
  const keys = Object.keys(await load()).filter(key => key !== 'withOperation');
  // Load the actual module per call so resetModules really reopens native storage.
  const wrap = (signal?: AbortSignal): LocalCacheDriver => ({ ...Object.fromEntries(keys.map(key => [key, async (...args: unknown[]) => {
    if (key === 'acknowledgeOperation' && f.failAck) throw new Error('Synthetic durable ACK failure');
    if (key === 'rebaseConflict' && f.beforeRebase) { const work = f.beforeRebase; f.beforeRebase = null; await work(); }
    const original = await load(), target = signal ? original.withOperation!(signal) : original;
    return Reflect.apply(target[key as keyof LocalCacheDriver] as (...values: unknown[]) => unknown, target, args);
  }])), withOperation: (next: AbortSignal) => wrap(next) }) as LocalCacheDriver;
  return { localCacheDriver: wrap() };
});
vi.mock('@/lib/supabase/client', () => ({ supabase: {
  auth: { getSession: async () => ({ data: { session: { user: { id: f.user }, access_token: 'synthetic-test-session' } }, error: null }) },
} }));
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock('@react-native-community/netinfo', () => ({ default: { addEventListener: () => () => undefined } }));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ state: { user: { id: f.user } } }) }));
vi.mock('@/lib/supabase/realtime', () => ({ subscribeTable: () => () => undefined }));
vi.mock('@/lib/env', () => ({ supabaseEnv: () => ({ url: 'http://fixture.invalid', anonKey: 'synthetic-public-key' }) }));
vi.mock('@/lib/local-cache/cache', () => ({
  activeCacheUserId: async () => f.user, getCached: async () => null, isTaskProjectBlocked: async () => false,
  isTransportFailure: (error: Error) => /Failed to fetch/.test(error.message),
}));
vi.mock('@/lib/local-cache/read-freshness', () => ({ readAccountEpoch: () => f.epoch }));
vi.mock('@/lib/local-cache/runtime-config', () => ({ RUNTIME_CONFIG_TTL_MS: 60000,
  runtimeCapabilities: async () => ({ sync: true, write: true, available: true }),
}));
vi.mock('@/lib/local-cache/status', () => ({ updateSyncState: () => undefined, notifySyncState: () => undefined,
  forgetSyncState: () => undefined, markSuccessfulSync: async () => undefined,
}));
vi.mock('@/lib/local-cache/outbox', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/local-cache/outbox')>(), offlineSyncEnabled: () => true,
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  from: () => {
    let id = '';
    const query = { select: () => query, eq: (_key: string, value: string) => { id = value; return query; },
      maybeSingle: async () => ({ data: f.items.get(id) ?? { id }, error: null }) };
    return query;
  },
  rpc: async (name: string, args: Record<string, unknown> = {}) => {
    if (name === 'get_task_item_sync_cursor') return { data: 0, error: null };
    if (name === 'pull_task_item_changes_v2') return { data: { changes: [], next_cursor: args.p_after_cursor, has_more: false }, error: null };
    if (name === 'get_task_item_snapshot_page') return { data: { revision: 0, total: f.items.size, offset: 0, rows: [...f.items.values()] }, error: null };
    if (name === 'get_client_operation_context') return { data: { protocol_version: 3, fingerprint_version: 1,
      generation: '11111111-1111-4111-8111-111111111111', epoch: 7, admit_until: '2030-01-02', replay_until: '2030-02-02' }, error: null };
    const id = args.p_operation_id as string, item = args.p_task_item_id as string;
    f.calls.push({ id, item, expected: args.p_expected_version as number, generation: args.p_generation as string, epoch: args.p_epoch as number });
    if (f.held && !f.holdAfterCommit) await f.held;
    if (f.terminal) {
      // A second request fails immediately: a red test never waits for the five-minute product watchdog.
      if (++f.terminalCalls > 1) throw new Error('Unexpected second terminal POST');
      if (f.terminal === 'STATE_RESULT_REDACTED') return { data: { state: 'result_redacted' }, error: null };
      return { data: null, error: { code: 'PT410', details: f.terminal, message: f.terminal } };
    }
    let result = f.receipts.get(id);
    if (!result) {
      const server = f.items.get(item)!;
      if (args.p_expected_version !== server.sync_version) result = { status: 'conflict', version: server.sync_version, item: { ...server } };
      else {
        server.percentage = args.p_percentage as number; server.is_completed = server.percentage === 100;
        server.sync_version! += 1; f.effects += 1;
        result = { status: 'applied', version: server.sync_version, item: { ...server } };
      }
      // V3 stores conflict outcomes too; v2 releases a conflicting claim.
      if (name.endsWith('_v3') || (result as { status: string }).status === 'applied') f.receipts.set(id, result);
    }
    if (f.held && f.holdAfterCommit) await f.held;
    if (f.loseAck) throw new TypeError('Failed to fetch');
    return { data: result, error: null };
  },
}) }));

export function offlineConflictRecoveryContract(native: boolean) {
  f.native = native;
  let d: LocalCacheDriver, sync: typeof import('@/lib/local-cache/sync');
  beforeEach(async () => {
    vi.resetModules(); f.db?.close(); f.db = native ? new DatabaseSync(':memory:') : null;
    await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase('tasktrace-local-cache'); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
    f.user = 'user-a'; f.epoch = 1; f.items = new Map(); f.receipts = new Map(); f.calls = [];
    f.effects = 0; f.loseAck = false; f.failAck = false; f.failAckTransaction = false; f.terminal = null; f.terminalCalls = 0; f.held = null; f.holdAfterCommit = false; f.beforeRebase = null;
    d = (await import('@/lib/local-cache/driver')).localCacheDriver; sync = await import('@/lib/local-cache/sync');
  });
  afterEach(() => { sync.cancelPendingSync('user-a'); f.db?.close(); f.db = null; vi.unstubAllGlobals(); });
  async function enqueue(id: string, item = 'item', protocol = 3) {
    return d.enqueue({ user_id: 'user-a', project_id: 'project', task_id: 'task', task_item_id: item,
      operation_id: id, type: 'set_task_item_percentage', payload: { percentage: 40 },
      status: 'pending', protocol_version: protocol, created_at: '2026-10-01' });
  }
  async function seed(protocol = 3) {
    const item = { id: 'item', task_id: 'task', title: 'Conflict item', sync_version: 10, percentage: 20, is_completed: false, comment: null };
    await d.put({ user_id: 'user-a', key: 'items:task:active', data: JSON.stringify([item]), last_synced_at: '', schema_version: 1 });
    await enqueue('22222222-2222-8222-8222-222222222222', 'item', protocol);
    f.items.set('item', { ...item, sync_version: 11, percentage: 100, is_completed: true });
    await sync.syncPendingOperations('user-a', true);
    expect(f.effects).toBe(0); expect((await d.listPending('user-a'))[0].status).toBe('conflict');
    return (await d.listConflicts('user-a'))[0].conflict_id;
  }
  async function restart() {
    sync.cancelPendingSync('user-a'); vi.resetModules();
    d = (await import('@/lib/local-cache/driver')).localCacheDriver; sync = await import('@/lib/local-cache/sync');
  }
  function locks() {
    const tails = new Map<string, Promise<unknown>>();
    vi.stubGlobal('navigator', { locks: { request: (key: string, options: { signal: AbortSignal }, work: () => unknown) => {
      const result = (tails.get(key) ?? Promise.resolve()).then(() => {
        if (options.signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
        return work();
      });
      tails.set(key, result.catch(() => undefined)); return result;
    } } });
  }
  describe(native ? 'N01/N02 SQLite conflict recovery' : 'N01/N02 IndexedDB conflict recovery', () => {
    it.each([2, 3])('N01 terminal expiry settles once and retains protocol %s draft', async protocol => {
      const conflict = await seed(protocol); f.calls = []; f.terminal = 'TT_OPERATION_EXPIRED';
      await expect(sync.chooseMine('user-a', conflict)).rejects.toThrow();
      expect(f.calls).toHaveLength(1);
      const row = (await d.listPending('user-a'))[0];
      expect(row.status).toBe('review'); expect(row.payload).toEqual({ percentage: 40 });
      expect(row.operation_id).toBe(f.calls[0].id);
      if (protocol === 3) expect(row.operation_handle).toMatchObject({ id: f.calls[0].id, generation: f.calls[0].generation, epoch: f.calls[0].epoch });
      const identity = { id: row.operation_id, handle: row.operation_handle };
      await sync.chooseMine('user-a', conflict).catch(() => undefined);
      expect(f.calls).toHaveLength(1);
      expect((await d.listPending('user-a'))[0]).toMatchObject({ operation_id: identity.id, operation_handle: identity.handle });
    });
    it.each(['lost ACK', 'ACK storage failure'])('N02 %s retries the same bound attempt after module restart', async failure => {
      const conflict = await seed(); f.calls = [];
      f.loseAck = failure === 'lost ACK'; f.failAck = failure === 'ACK storage failure';
      await expect(sync.chooseMine('user-a', conflict)).rejects.toThrow();
      const before = (await d.listPending('user-a'))[0];
      expect(before.status).toBe('pending'); expect(before.operation_handle?.id).toBe(before.operation_id); expect(f.effects).toBe(1);
      sync.cancelPendingSync('user-a'); vi.resetModules();
      d = (await import('@/lib/local-cache/driver')).localCacheDriver; sync = await import('@/lib/local-cache/sync');
      f.loseAck = false; f.failAck = false;
      await sync.chooseMine('user-a', conflict);
      expect(new Set(f.calls.map(call => call.id))).toEqual(new Set([before.operation_id]));
      expect(new Set(f.calls.map(call => call.generation))).toEqual(new Set([before.operation_handle!.generation]));
      expect(new Set(f.calls.map(call => call.epoch))).toEqual(new Set([before.operation_handle!.epoch]));
      expect(new Set(f.calls.map(call => call.expected))).toEqual(new Set([11]));
      expect(f.effects).toBe(1); expect(await d.listPending('user-a')).toEqual([]); expect(await d.listConflicts('user-a')).toEqual([]);
    });
    it.each(['TT_OPERATION_HISTORY_RESET', 'TT_OPERATION_RESULT_REDACTED', 'TT_OPERATION_INVALID_EPOCH', 'TT_OPERATION_NAMESPACE', 'TT_OPERATION_WINDOW_CLOSING', 'TT_HISTORY_RESET', 'TT_RESULT_REDACTED', 'STATE_RESULT_REDACTED'])('N01 %s never resends after restart', async terminal => {
      const conflict = await seed(); f.calls = []; f.terminal = terminal;
      await expect(sync.chooseMine('user-a', conflict)).rejects.toThrow();
      const saved = (await d.listPending('user-a'))[0]; expect(saved.status).toBe('review');
      await restart(); await sync.chooseMine('user-a', conflict); await sync.syncPendingOperations('user-a', true);
      expect(f.calls).toHaveLength(1); expect((await d.listPending('user-a'))[0]).toEqual(saved); expect(await d.listConflicts('user-a')).toEqual([]);
    });
    it('N01 v1 preserves its UUID for review without calling a mutation', async () => {
      const conflict = await seed(); const row = (await d.listPending('user-a'))[0];
      // A genuine old record has no v3 context and must never be upgraded.
      if (native) f.db!.prepare('UPDATE pending_operations SET protocol_version=1,operation_handle=NULL WHERE operation_id=?').run(row.operation_id);
      else await new Promise<void>((resolve, reject) => {
        const r = indexedDB.open('tasktrace-local-cache'); r.onsuccess = () => {
          const db = r.result, tx = db.transaction('pending_operations', 'readwrite');
          tx.objectStore('pending_operations').put({ ...row, protocol_version: 1, operation_handle: null });
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => { db.close(); reject(tx.error); };
        };
      });
      f.calls = []; await expect(sync.chooseMine('user-a', conflict)).rejects.toThrow();
      await sync.chooseMine('user-a', conflict);
      expect(f.calls).toEqual([]); expect((await d.listPending('user-a'))[0]).toMatchObject({ operation_id: row.operation_id, protocol_version: 1, status: 'review' });
    });
    it('N01 an old reviewed row with surviving conflict metadata recovers without a POST', async () => {
      const conflict = await seed(), row = (await d.listPending('user-a'))[0];
      await d.markOperation('user-a', row.operation_id, 'review', undefined, 'TT_OPERATION_EXPIRED');
      const before = (await d.listPending('user-a'))[0]; f.calls = []; await restart();
      await expect(sync.chooseMine('user-a', conflict)).rejects.toThrow();
      expect(f.calls).toEqual([]); expect((await d.listPending('user-a'))[0]).toEqual(before);
      expect(await d.listConflicts('user-a')).toEqual([]);
    });
    it('N01 releases the global gate, keeps a dependent draft and runs independent work', async () => {
      const conflict = await seed();
      // Append an old durable dependent to the existing conflict snapshot.
      await d.markOperation('user-a', (await d.listPending('user-a'))[0].operation_id, 'pending');
      const dependent = await enqueue('33333333-3333-8333-8333-333333333333');
      const original = (await d.listConflicts('user-a'))[0];
      await d.createConflict({ ...original, operation_ids: [...original.operation_ids, dependent.operation_id] });
      const independent = { ...f.items.get('item')!, id: 'other', sync_version: 1 };
      f.items.set('other', independent);
      await d.put({ user_id: 'user-a', key: 'items:task:active', data: JSON.stringify([...f.items.values()]), last_synced_at: '', schema_version: 1 });
      await enqueue('44444444-4444-8444-8444-444444444444', 'other');
      f.calls = []; f.terminal = 'TT_OPERATION_EXPIRED';
      await expect(sync.chooseMine('user-a', conflict)).rejects.toThrow();
      f.terminal = null; await sync.syncPendingOperations('user-a', true);
      const rows = await d.listPending('user-a');
      expect(rows.map(row => row.status)).toEqual(['review', 'pending']);
      expect(rows[1]).toMatchObject({ operation_id: dependent.operation_id, depends_on_operation_id: rows[0].operation_id });
      expect(await d.listConflicts('user-a')).toEqual([]);
      expect(f.calls.filter(call => call.item === 'item')).toHaveLength(1);
      expect(f.calls.filter(call => call.item === 'other')).toHaveLength(1); expect(f.effects).toBe(1);
    });
    it('N02 retains the dependent chain and gives a later independent intent a new ID', async () => {
      const conflict = await seed();
      await d.markOperation('user-a', (await d.listPending('user-a'))[0].operation_id, 'pending');
      const dependent = await enqueue('33333333-3333-8333-3333-333333333333');
      const before = (await d.listConflicts('user-a'))[0]; await d.createConflict({ ...before, operation_ids: [...before.operation_ids, dependent.operation_id] });
      f.calls = []; f.loseAck = true;
      await expect(sync.chooseMine('user-a', conflict)).rejects.toThrow();
      const rows = await d.listPending('user-a'); expect(rows[1].depends_on_operation_id).toBe(rows[0].operation_id);
      f.loseAck = false; await sync.chooseMine('user-a', conflict);
      expect(f.calls.filter(call => call.id !== dependent.operation_id).every(call => call.id === rows[0].operation_id)).toBe(true);
      expect(f.calls.at(-1)).toMatchObject({ id: dependent.operation_id, expected: 12 }); expect(f.effects).toBe(2);
      expect(await d.listPending('user-a')).toEqual([]);
      const fresh = await enqueue('55555555-5555-8555-8555-555555555555'); await sync.syncPendingOperations('user-a', true);
      expect(f.calls.at(-1)?.id).toBe(fresh.operation_id); expect(f.effects).toBe(3);
    });
    it('N02 a failure inside the actual ACK transaction rolls back the local ACK and safely replays', async () => {
      const conflict = await seed(); f.calls = [];
      const put = IDBObjectStore.prototype.put;
      const abortAck = native ? null : vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, value, key) {
        const result = Reflect.apply(put, this, key === undefined ? [value] : [value, key]);
        if (this.name === 'pending_operations' && value.status === 'synced_unreconciled') queueMicrotask(() => {
          try { this.transaction.abort(); } catch { /* An already aborted transaction is also a safe rollback. */ }
        });
        return result;
      });
      f.failAckTransaction = native;
      try { await expect(sync.chooseMine('user-a', conflict)).rejects.toThrow(); }
      finally { abortAck?.mockRestore(); f.failAckTransaction = false; }
      const before = (await d.listPending('user-a'))[0]; expect(before.status).toBe('pending'); expect(f.effects).toBe(1);
      await sync.chooseMine('user-a', conflict);
      expect(f.calls.every(call => call.id === before.operation_id)).toBe(true); expect(f.effects).toBe(1);
      expect(await d.listPending('user-a')).toEqual([]);
    });
    it('N02 legacy v2 lost replies retain the old UUID and expected version', async () => {
      const conflict = await seed(2); f.calls = []; f.loseAck = true;
      await expect(sync.chooseMine('user-a', conflict)).rejects.toThrow();
      const before = (await d.listPending('user-a'))[0]; f.loseAck = false; await restart();
      await sync.chooseMine('user-a', conflict);
      expect(f.calls.every(call => call.id === before.operation_id && call.expected === 11)).toBe(true);
      expect(f.effects).toBe(1); expect(await d.listPending('user-a')).toEqual([]);
    });
    it.each([false, true])('N02 queued chooseMine is serialized with ordinary sync (other module: %s)', async otherModule => {
      locks(); const conflict = await seed(); f.calls = [];
      let release!: () => void; f.held = new Promise<void>(resolve => { release = resolve; });
      const a = sync.chooseMine('user-a', conflict);
      await vi.waitFor(() => expect(f.calls).toHaveLength(1));
      let second = sync;
      if (otherModule) { vi.resetModules(); second = await import('@/lib/local-cache/sync'); }
      const b = second.chooseMine('user-a', conflict), normal = second.syncPendingOperations('user-a', true);
      release(); await Promise.all([a, b, normal]);
      expect(f.calls).toHaveLength(1); expect(f.effects).toBe(1); expect(await d.listPending('user-a')).toEqual([]);
      second.cancelPendingSync('user-a');
    });
    it.each(['cancel', 'account switch'])('N02 late committed reply after %s cannot ACK or replace the handle', async reason => {
      const conflict = await seed(); f.calls = []; f.holdAfterCommit = true;
      let release!: () => void; f.held = new Promise<void>(resolve => { release = resolve; });
      const action = sync.chooseMine('user-a', conflict), rejected = expect(action).rejects.toThrow();
      await vi.waitFor(() => expect(f.effects).toBe(1));
      const before = (await d.listPending('user-a'))[0];
      if (reason === 'account switch') { f.user = 'user-b'; f.epoch += 1; }
      sync.cancelPendingSync('user-a'); await rejected; release(); f.held = null;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect((await d.listPending('user-a'))[0]).toEqual(before);
      f.user = 'user-a'; f.epoch += 1; await sync.chooseMine('user-a', conflict);
      expect(f.calls.every(call => call.id === before.operation_id)).toBe(true); expect(f.effects).toBe(1);
      expect(await d.listPending('user-a')).toEqual([]);
    });
    it('N02 rechecks current attempt atomically if another writer rebases after preflight', async () => {
      const conflict = await seed(); f.calls = []; let sent: OfflineOperation | undefined;
      f.beforeRebase = async () => {
        const { localCacheDriver: raw } = f.native ? await import('@/lib/local-cache/driver.native') : await import('@/lib/local-cache/driver.web');
        await raw.rebaseConflict('user-a', conflict, 11);
        const row = (await raw.listPending('user-a'))[0];
        sent = await raw.bindOperationHandle('user-a', row.operation_id, { id: row.operation_id, protocol_version: 3, fingerprint_version: 1,
          generation: '11111111-1111-4111-8111-111111111111', epoch: 7, admit_until: '2030-01-02', replay_until: '2030-02-02' });
        const item = f.items.get('item')!; item.sync_version = 12; item.percentage = 40; item.is_completed = false;
        f.receipts.set(sent.operation_id, { status: 'applied', version: 12, item: { ...item } }); f.effects += 1;
      };
      await sync.chooseMine('user-a', conflict);
      expect(f.calls).toHaveLength(1); expect(f.calls[0].id).toBe(sent!.operation_id); expect(f.effects).toBe(1);
      expect(await d.listPending('user-a')).toEqual([]);
    });
  });
}
