import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { usesLocalReads } from '@/lib/connectivity/state';
import { connectivityFetch } from '@/lib/connectivity/fetch';
import { boundedOperation } from '@/lib/connectivity/deadline';
import { supabase, type Database } from '@/lib/supabase/client';
import { supabaseEnv } from '@/lib/env';
import { activeCacheUserId, getCached, isTransportFailure } from './cache';
import { announceConflictChange, recordConflict, unresolvedConflicts } from './conflicts';
import { localCacheDriver } from './driver';
import { listPendingOperations, offlineSyncEnabled } from './outbox';
import { hasMeaningfulPull, validSyncVersion } from './pull-cache';
import { RUNTIME_CONFIG_TTL_MS, runtimeCapabilities } from './runtime-config';
import { markSuccessfulSync, notifySyncState, updateSyncState } from './status';
import type { OfflineOperation, PullChange, ReconciledItem, SyncConflict, LocalCacheDriver } from './types';
import { startRuntimeOperation, cancelRuntimeOperation, type OperationTicket } from './runtime-state';
import { requestOfflineWork } from './work-requests';
import { reconciledKeys } from './reconcile';
import { denyCacheAccess } from './access-state';

type V2Result = { status: 'applied' | 'conflict'; version: number; item: ReconciledItem };
type PullPage = { changes: PullChange[]; next_cursor: number; has_more: boolean } | { reset_required: true; retained_after_cursor: number };

const inFlight = new Map<string, Promise<void>>();
const syncTickets = new Map<string, OperationTicket>();
const rerunRequested = new Set<string>();
const backoff = new Map<string, { failures: number; until: number }>();
const retryTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; until: number }>();
const listeners = new Set<(userId: string) => void>();

export function subscribeSyncChanges(listener: (userId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function announceSyncChange(userId: string): void {
  for (const listener of listeners) listener(userId);
  notifySyncState(userId);
}
const sameUser = async (userId: string) => await activeCacheUserId() === userId;
const SYNC_REQUEST_TIMEOUT_MS = 20_000;
type SyncContext = { ticket: OperationTicket; storage: LocalCacheDriver; wait: <T>(work: () => PromiseLike<T>) => Promise<T> };
function syncContext(ticket: OperationTicket): SyncContext {
  const wait = async <T,>(work: () => PromiseLike<T>): Promise<T> => {
    ticket.assertCurrent();
    const value = await boundedOperation(work, SYNC_REQUEST_TIMEOUT_MS, ticket.signal);
    ticket.assertCurrent(); return value;
  };
  const operationDriver = localCacheDriver.withOperation?.(ticket.signal) ?? localCacheDriver;
  const storage = new Proxy(operationDriver, { get(target, name: keyof LocalCacheDriver) {
    const method = target[name];
    if (typeof method !== 'function') return method;
    return (...args: unknown[]) => wait(() => Reflect.apply(method, target, args)).catch((error) => {
      if ((error as Error)?.name === 'TimeoutError') throw Object.assign(new Error('Локальное хранилище не ответило.'), { code: 'LOCAL_STORAGE' });
      throw error;
    });
  } });
  return { ticket, storage, wait };
}
function syncRead<T>(query: PromiseLike<T> & { abortSignal?: (signal: AbortSignal) => PromiseLike<T> }, ctx?: SyncContext) {
  return boundedOperation((signal) => query.abortSignal?.(signal) ?? query, SYNC_REQUEST_TIMEOUT_MS, ctx?.ticket.signal)
    .then((value) => { ctx?.ticket.assertCurrent(); return value; });
}
export function cancelPendingSync(userId: string): void {
  cancelRuntimeOperation(userId, 'sync'); clearRetry(userId); rerunRequested.delete(userId);
  syncTickets.delete(userId); inFlight.delete(userId);
}

function scheduleRetry(userId: string, until: number): void {
  const existing = retryTimers.get(userId);
  if (existing && existing.until <= until) return;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    retryTimers.delete(userId);
    void sameUser(userId).then((active) => {
      if (active) void (requestOfflineWork(userId, 'mutations') ?? syncPendingOperations(userId)).catch(() => undefined);
    }).catch(() => undefined);
  }, Math.max(25, until - Date.now()));
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  retryTimers.set(userId, { timer, until });
}

function clearRetry(userId: string): void {
  const existing = retryTimers.get(userId);
  if (existing) clearTimeout(existing.timer);
  retryTimers.delete(userId);
}

async function clientFor(userId: string, ctx?: SyncContext): Promise<SupabaseClient<Database> | null> {
  const { data, error } = await boundedOperation(() => supabase.auth.getSession(), SYNC_REQUEST_TIMEOUT_MS, ctx?.ticket.signal);
  ctx?.ticket.assertCurrent();
  const session = data.session;
  if (error || !session || session.user.id !== userId ||
    (session.expires_at && session.expires_at * 1000 <= Date.now())) return null;
  const { url, anonKey } = supabaseEnv();
  return createClient<Database>(url, anonKey, {
    accessToken: async () => session.access_token,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: connectivityFetch },
  });
}

async function send(client: SupabaseClient<Database>, operation: OfflineOperation, ctx: SyncContext): Promise<V2Result> {
  if (operation.protocol_version && operation.protocol_version > 2) throw new Error('Unsupported local protocol version');
  if (!['set_task_item_state', 'set_task_item_percentage', 'set_task_item_comment'].includes(operation.type))
    throw new Error('Unsupported local operation type');
  if (!validSyncVersion(operation.expected_version)) throw new Error('Operation has no confirmed server version');
  const common = { p_operation_id: operation.operation_id, p_task_item_id: operation.task_item_id,
    p_expected_version: operation.expected_version };
  const response = await syncRead(operation.type === 'set_task_item_state'
    ? client.rpc('apply_task_item_state_operation_v2', { ...common,
      p_completed: (operation.payload as { completed: boolean }).completed })
    : operation.type === 'set_task_item_percentage'
      ? client.rpc('apply_task_item_percentage_operation_v2', { ...common,
        p_percentage: (operation.payload as { percentage: number }).percentage })
      : client.rpc('apply_task_item_comment_operation_v2', { ...common,
        p_comment: (operation.payload as { comment: string | null }).comment ?? '' }), ctx);
  if (response.error) throw response.error;
  const result = response.data as V2Result | null;
  if (!result || !['applied', 'conflict'].includes(result.status) || !validSyncVersion(result.version)
    || !result.item || result.item.id !== operation.task_item_id) throw new Error('Invalid sync response');
  return result;
}

function deterministicRejection(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | null;
  if (isTransportFailure(error)) return false;
  if (/jwt|token|session|authentication/i.test(value?.message ?? '')) return false;
  return ['42501', '22023', '23514', 'P0001', '22P02'].includes(value?.code ?? '');
}

async function taskSnapshot(client: SupabaseClient<Database>, taskId: string, ctx: SyncContext): Promise<ReconciledItem[]> {
  const rows: ReconciledItem[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await syncRead(client.from('task_items').select('*').eq('task_id', taskId)
      .order('position').order('id').range(from, from + 499), ctx);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 500) break;
  }
  return rows;
}

async function reconcile(client: SupabaseClient<Database>, operation: OfflineOperation, ctx: SyncContext): Promise<void> {
  if (!await ctx.wait(() => sameUser(operation.user_id))) throw new Error('Session changed');
  const before = await ctx.storage.listEntries(operation.user_id);
  const guards = [...reconciledKeys(operation), 'sync:task-items:cursor'].map((key) => ({ key, data: before.find((entry) => entry.key === key)?.data ?? null }));
  const access = await syncRead(client.from('tasks').select('id').eq('id', operation.task_id).maybeSingle(), ctx);
  if (access.error) throw access.error;
  if (!access.data) {
    denyCacheAccess(operation.user_id, `blocked-task:${operation.task_id}`);
    await ctx.storage.put({ user_id: operation.user_id, key: `blocked-task:${operation.task_id}`, data: 'true', last_synced_at: new Date().toISOString(), schema_version: 1 });
    await ctx.storage.reconcileOperation(operation.user_id, operation.operation_id, null, null, guards);
    announceSyncChange(operation.user_id);
    return;
  }
  const snapshot = await taskSnapshot(client, operation.task_id, ctx);
  // A structural change can shift paginated rows. Confirm absence by ID before
  // retiring a deletion, rather than treating a pagination gap as a tombstone.
  const item = snapshot.find((row) => row.id === operation.task_item_id)
    ?? await fetchServerItem(client, operation.task_item_id, ctx);
  if (item && !snapshot.some((row) => row.id === item.id)) snapshot.push(item);
  if (!await ctx.wait(() => sameUser(operation.user_id))) throw new Error('Session changed');
  await ctx.storage.reconcileOperation(operation.user_id, operation.operation_id, item, snapshot, guards);
  announceSyncChange(operation.user_id);
}

async function fetchServerItem(client: SupabaseClient<Database>, itemId: string, ctx?: SyncContext): Promise<ReconciledItem | null> {
  const { data, error } = await syncRead(client.from('task_items').select('*').eq('id', itemId).maybeSingle(), ctx);
  if (error) throw error;
  return data;
}

async function bootstrapPull(client: SupabaseClient<Database>, userId: string, ctx: SyncContext, previousCursor?: import('./types').CacheEntry): Promise<void> {
  const { data, error } = await syncRead(client.rpc('get_task_item_sync_cursor'), ctx);
  if (error) throw error;
  const start = Number(data);
  if (!Number.isSafeInteger(start) || start < 0) throw new Error('Invalid starting sync cursor');
  // Refresh only task-item lists already present in the local confirmed cache.
  // Changes committed during this refresh are replayed from the earlier cursor.
  const entries = await ctx.storage.listEntries(userId, 'items:');
  for (const entry of entries) {
    if (!await ctx.wait(() => sameUser(userId))) return;
    const match = /^items:([^:]+):(active|archived|all)$/.exec(entry.key);
    if (!match) continue;
    const [, taskId, mode] = match;
    const taskResult = await syncRead(client.from('tasks').select('id').eq('id', taskId).maybeSingle(), ctx);
    if (taskResult.error) throw taskResult.error;
    if (!taskResult.data) { await ctx.storage.remove(userId, entry.key); continue; }
    const rows: ReconciledItem[] = [];
    for (let from = 0; ; from += 500) {
      let query = client.from('task_items').select('*').eq('task_id', taskId).order('position').range(from, from + 499);
      if (mode !== 'all') query = query.eq('is_archived', mode === 'archived');
      const { data: page, error: pageError } = await syncRead(query, ctx);
      if (pageError) throw pageError;
      rows.push(...(page ?? []));
      if (!page || page.length < 500) break;
    }
    await ctx.storage.putIfUnchanged({ ...entry, data: JSON.stringify(rows),
      last_synced_at: new Date().toISOString() }, entry.data);
  }
  if (!await ctx.wait(() => sameUser(userId))) return;
  if (previousCursor) {
    await ctx.storage.putIfUnchanged({ ...previousCursor, data: JSON.stringify(start),
      last_synced_at: new Date().toISOString() }, previousCursor.data);
  } else await ctx.storage.initializePullCursor(userId, start);
}

async function pull(client: SupabaseClient<Database>, userId: string, ctx: SyncContext): Promise<void> {
  let entry = await ctx.storage.get(userId, 'sync:task-items:cursor');
  if (!entry) {
    await bootstrapPull(client, userId, ctx);
    entry = await ctx.storage.get(userId, 'sync:task-items:cursor');
  }
  if (!entry) return;
  let cursor = Number(JSON.parse(entry.data));
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid local sync cursor');
  for (let pageIndex = 0; pageIndex < 10000 && await ctx.wait(() => sameUser(userId)); pageIndex += 1) {
    const { data, error } = await syncRead(client.rpc('pull_task_item_changes_v2', { p_after_cursor: cursor, p_limit: 100 }), ctx);
    if (error) throw error;
    const page = data as PullPage | null;
    if (page && 'reset_required' in page && page.reset_required === true) {
      if (!Number.isSafeInteger(page.retained_after_cursor) || page.retained_after_cursor <= cursor)
        throw new Error('Invalid cursor reset response');
      await bootstrapPull(client, userId, ctx, entry);
      entry = await ctx.storage.get(userId, 'sync:task-items:cursor');
      if (!entry) throw new Error('Cursor reset failed');
      cursor = Number(JSON.parse(entry.data));
      pageIndex = -1;
      continue;
    }
    if (!page || !('changes' in page) || !Array.isArray(page.changes) || !Number.isSafeInteger(page.next_cursor)
      || page.next_cursor < cursor || typeof page.has_more !== 'boolean') throw new Error('Invalid pull page');
    if (!await ctx.wait(() => sameUser(userId))) return;
    const meaningful = page.changes.length > 0 && hasMeaningfulPull(await ctx.storage.listEntries(userId), page.changes);
    const applied = await ctx.storage.applyPullPage(userId, cursor, page.next_cursor, page.changes);
    if (!applied) return; // Another tab advanced the cursor; its transaction owns the page.
    cursor = page.next_cursor;
    if (meaningful) announceSyncChange(userId);
    if (!page.has_more) return;
  }
  throw new Error('Pull page limit exceeded');
}

async function push(client: SupabaseClient<Database>, userId: string, ctx: SyncContext, allowedConflict?: SyncConflict): Promise<boolean> {
  let completed = 0;
  let total: number | null = null;
  while (await ctx.wait(() => sameUser(userId))) {
    if (!allowedConflict && (await ctx.wait(() => unresolvedConflicts(userId))).length) return false;
    const operations = await ctx.wait(() => listPendingOperations(userId));
    total ??= operations.length;
    updateSyncState(userId, { progress: { done: completed, total } }, ctx.ticket);
    if (completed % 20 === 0 && !(await ctx.wait(() => runtimeCapabilities(userId, true, { requireServer: true }))).sync) {
      updateSyncState(userId, { lastErrorKind: 'disabled' }, ctx.ticket);
      return false;
    }
    const oldest = allowedConflict
      ? operations.find((row) => allowedConflict.operation_ids.includes(row.operation_id))
      : operations[0];
    if (!oldest) return true;
    if (oldest.status === 'failed' || oldest.status === 'conflict') return false;
    updateSyncState(userId, { isSyncing: true }, ctx.ticket);
    if ((oldest.protocol_version && oldest.protocol_version > 2)
      || !['set_task_item_state', 'set_task_item_percentage', 'set_task_item_comment'].includes(oldest.type)) {
      await ctx.storage.markOperation(userId, oldest.operation_id, 'failed', undefined, 'Требуется новая версия приложения.');
      announceSyncChange(userId);
      return false;
    }
    if (oldest.status === 'synced_unreconciled') {
      try { await reconcile(client, oldest, ctx); completed += 1; } catch { return false; }
      continue;
    }
    if (!validSyncVersion(oldest.expected_version)) {
      if (oldest.depends_on_operation_id) return false;
      const serverState = await fetchServerItem(client, oldest.task_item_id, ctx);
      const chain = operations.filter((row) => row.task_item_id === oldest.task_item_id);
      await ctx.wait(() => recordConflict({ userId, operations: chain, serverState,
        serverVersion: serverState?.sync_version ?? null, conflictId: allowedConflict?.conflict_id }, ctx.storage));
      return false;
    }
    let result: V2Result | null = null;
    for (let attempt = 0; attempt < 3 && await ctx.wait(() => sameUser(userId)); attempt += 1) {
      try { result = await send(client, oldest, ctx); break; }
      catch (error) {
        if (!await ctx.wait(() => sameUser(userId))) return false;
        if (deterministicRejection(error)) {
          await ctx.storage.markOperation(userId, oldest.operation_id, 'failed', undefined,
            (error as { message?: string }).message ?? 'Server rejected operation');
          if ((error as { code?: string }).code === '42501') {
            const access = await syncRead(client.from('tasks').select('id').eq('id', oldest.task_id).maybeSingle(), ctx);
            if (!access.error && !access.data && await ctx.wait(() => sameUser(userId))) {
              denyCacheAccess(userId, `blocked-task:${oldest.task_id}`);
              await ctx.storage.put({ user_id: userId, key: `blocked-task:${oldest.task_id}`,
                data: 'true', last_synced_at: new Date().toISOString(), schema_version: 1 });
            }
          }
          announceSyncChange(userId);
          return false;
        }
        if (!isTransportFailure(error) || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
    if (!result || !await ctx.wait(() => sameUser(userId))) return false;
    if (result.status === 'conflict') {
      await ctx.wait(() => recordConflict({ userId, operations: operations.filter((row) => row.task_item_id === oldest.task_item_id),
        serverState: result.item, serverVersion: result.version, conflictId: allowedConflict?.conflict_id }, ctx.storage));
      return false;
    }
    await ctx.storage.acknowledgeOperation(userId, oldest.operation_id, result.version,
      allowedConflict?.conflict_id, result.item);
    announceSyncChange(userId);
    try { await reconcile(client, oldest, ctx); completed += 1; } catch { return false; }
  }
  return false;
}

async function run(userId: string, ctx: SyncContext, allowedConflict?: SyncConflict): Promise<boolean> {
  if (!offlineSyncEnabled() || !await ctx.wait(() => sameUser(userId))) return false;
  const capabilities = await ctx.wait(() => runtimeCapabilities(userId, true, { requireServer: true }));
  if (!capabilities.sync) {
    updateSyncState(userId, { lastErrorKind: capabilities.available ? 'disabled' : 'config-unavailable' }, ctx.ticket);
    const failures = capabilities.available ? 0 : Math.min((backoff.get(userId)?.failures ?? 0) + 1, 5);
    const delay = capabilities.available ? RUNTIME_CONFIG_TTL_MS : Math.min(60_000, 5_000 * 2 ** (failures - 1));
    const until = Date.now() + delay;
    backoff.set(userId, { failures, until });
    scheduleRetry(userId, until);
    return false;
  }
  const client = await clientFor(userId, ctx);
  if (!client) {
    const until = Date.now() + 30_000;
    backoff.set(userId, { failures: 0, until });
    scheduleRetry(userId, until);
    updateSyncState(userId, { lastErrorKind: 'auth' }, ctx.ticket);
    return false;
  }
  if (!allowedConflict) {
    if ((await ctx.wait(() => listPendingOperations(userId))).some((row) => row.status === 'pending' || row.status === 'synced_unreconciled'))
      updateSyncState(userId, { isSyncing: true }, ctx.ticket);
    await pull(client, userId, ctx);
  }
  if (!await ctx.wait(() => sameUser(userId))) return false;
  const pushed = await push(client, userId, ctx, allowedConflict);
  if (allowedConflict) return pushed;
  if (!await ctx.wait(() => sameUser(userId))) return false;
  await pull(client, userId, ctx);
  if (!await ctx.wait(() => sameUser(userId))) return false;
  const remaining = await ctx.wait(() => listPendingOperations(userId));
  const conflicts = await ctx.wait(() => unresolvedConflicts(userId));
  if (pushed && !remaining.length && !conflicts.length) {
    await ctx.wait(() => markSuccessfulSync(userId, ctx.ticket, ctx.storage));
    return true;
  }
  return false;
}

async function coordinatedRun(userId: string, ctx: SyncContext): Promise<boolean> {
  if (usesLocalReads()) {
    const until = Date.now() + 30_000;
    backoff.set(userId, { failures: 0, until });
    scheduleRetry(userId, until);
    updateSyncState(userId, { connectivity: 'offline', lastErrorKind: 'transport' }, ctx.ticket);
    return false;
  }
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(`tasktrace-sync:${userId}`, { signal: ctx.ticket.signal }, async () => { ctx.ticket.assertCurrent(); return run(userId, ctx); });
  }
  return run(userId, ctx);
}

export function syncPendingOperations(userId: string, manual = false): Promise<void> {
  if (!offlineSyncEnabled()) return Promise.resolve();
  const existing = inFlight.get(userId);
  if (existing) return existing;
  if (!manual && Date.now() < (backoff.get(userId)?.until ?? 0)) {
    scheduleRetry(userId, backoff.get(userId)!.until);
    return Promise.resolve();
  }
  const ticket = startRuntimeOperation(userId, 'sync', 'refresh', 5 * 60_000);
  syncTickets.set(userId, ticket);
  const ctx = syncContext(ticket);
  const task = boundedOperation(async () => {
    updateSyncState(userId, { lastErrorKind: null }, ticket);
    try {
      const succeeded = await coordinatedRun(userId, ctx);
      if (succeeded) { backoff.delete(userId); clearRetry(userId); }
      else if (await ctx.wait(() => sameUser(userId))) {
        const operations = await ctx.wait(() => listPendingOperations(userId));
        if (operations.some((row) => row.status === 'pending' || row.status === 'synced_unreconciled')
          && !operations.some((row) => row.status === 'failed' || row.status === 'conflict')
          && !(await ctx.wait(() => unresolvedConflicts(userId))).length)
          scheduleRetry(userId, Math.max(Date.now() + 3_000, backoff.get(userId)?.until ?? 0));
      }
      ticket.finish(succeeded ? 'success' : usesLocalReads() ? 'waiting-network' : 'partial');
    } catch (error) {
      if (!ticket.current()) return;
      const previous = backoff.get(userId)?.failures ?? 0;
      const failures = Math.min(previous + 1, 6);
      const until = Date.now() + Math.min(30_000, 1000 * 2 ** (failures - 1));
      backoff.set(userId, { failures, until });
      scheduleRetry(userId, until);
      updateSyncState(userId, { lastErrorKind: isTransportFailure(error) ? 'transport' : 'server' }, ticket);
      ticket.finish(isTransportFailure(error) ? 'waiting-network' : 'error', error instanceof Error ? error.message : 'Sync failed');
      throw error;
    } finally {
      ticket.finish(usesLocalReads() ? 'waiting-network' : 'success');
    }
  }, 5 * 60_000, ticket.signal).catch((error) => {
    if (ticket.signal.aborted) return;
    ticket.finish('error', error instanceof Error ? error.message : 'Sync failed'); throw error;
  }).finally(() => {
    if (inFlight.get(userId) === task) inFlight.delete(userId);
    if (syncTickets.get(userId) === ticket) syncTickets.delete(userId);
  });
  inFlight.set(userId, task);
  return task;
}

export async function chooseMine(userId: string, conflictId: string): Promise<void> {
  if (!offlineSyncEnabled() || !(await runtimeCapabilities(userId, true, { requireServer: true })).sync || !await sameUser(userId))
    throw new Error('Синхронизация временно отключена. Ваш вариант сохранён на устройстве.');
  const conflict = (await unresolvedConflicts(userId)).find((row) => row.conflict_id === conflictId);
  if (!conflict) throw new Error('Конфликт недоступен.');
  if (!validSyncVersion(conflict.server_version)) throw new Error('Серверный пункт удалён. Оставьте серверное состояние.');
  const existing = inFlight.get(userId);
  if (existing) await existing;
  if (!(await listPendingOperations(userId)).some((row) => conflict.operation_ids.includes(row.operation_id))) {
    await localCacheDriver.finishMineConflict(userId, conflictId);
    announceConflictChange(userId);
    return;
  }
  await localCacheDriver.rebaseConflict(userId, conflictId, conflict.server_version);
  const ticket = startRuntimeOperation(userId, 'sync', 'synchronization', 5 * 60_000, true);
  syncTickets.set(userId, ticket);
  const task = boundedOperation(() => run(userId, syncContext(ticket), conflict), 5 * 60_000, ticket.signal).then(() => undefined);
  inFlight.set(userId, task);
  try { await task; } finally {
    ticket.finish('partial');
    if (inFlight.get(userId) === task) inFlight.delete(userId);
    if (syncTickets.get(userId) === ticket) syncTickets.delete(userId);
  }
  const remaining = (await listPendingOperations(userId)).filter((row) => conflict.operation_ids.includes(row.operation_id));
  if (remaining.length) throw new Error('Не удалось применить ваш вариант. Проверьте подключение и повторите.');
  await localCacheDriver.finishMineConflict(userId, conflictId);
  announceConflictChange(userId);
  announceSyncChange(userId);
  void syncPendingOperations(userId).catch(() => undefined);
}

export async function retryFailedOperation(userId: string, operationId: string): Promise<void> {
  if (!(await runtimeCapabilities(userId, true, { requireServer: true })).sync || !await sameUser(userId))
    throw new Error('Синхронизация временно отключена.');
  const existing = inFlight.get(userId);
  if (existing) await existing;
  const operations = await listPendingOperations(userId);
  const failed = operations.find((row) => row.operation_id === operationId && row.status === 'failed');
  if (!failed) throw new Error('Неудавшееся изменение не найдено.');
  const client = await clientFor(userId);
  if (!client) throw new Error('Требуется авторизация.');
  const access = await client.from('tasks').select('id').eq('id', failed.task_id).maybeSingle();
  if (access.error) throw access.error;
  if (!access.data) throw new Error('Доступ к этапу отозван.');
  const serverState = await fetchServerItem(client, failed.task_item_id);
  if (!serverState || !validSyncVersion(serverState.sync_version)
    || serverState.sync_version !== failed.expected_version || serverState.is_archived) {
    await recordConflict({ userId, operations: operations.filter((row) => row.task_item_id === failed.task_item_id),
      serverState, serverVersion: serverState?.sync_version ?? null });
    announceSyncChange(userId);
    return;
  }
  if (!await sameUser(userId)) throw new Error('Сеанс изменился.');
  await localCacheDriver.remove(userId, `blocked-task:${failed.task_id}`);
  await localCacheDriver.remove(userId, `blocked:${failed.project_id}`);
  await localCacheDriver.markOperation(userId, operationId, 'pending');
  announceSyncChange(userId);
  await syncPendingOperations(userId, true);
}

export async function discardFailedOperation(userId: string, operationId: string): Promise<void> {
  if (!await sameUser(userId)) throw new Error('Требуется авторизация.');
  const existing = inFlight.get(userId);
  if (existing) await existing;
  const failed = (await listPendingOperations(userId)).find((row) => row.operation_id === operationId && row.status === 'failed');
  if (!failed) throw new Error('Неудавшееся изменение не найдено.');
  const locallyBlocked = await getCached<boolean>(userId, `blocked-task:${failed.task_id}`)
    || await getCached<boolean>(userId, `blocked:${failed.project_id}`);
  const client = await clientFor(userId);
  let serverState: ReconciledItem | null = null;
  let useCachedSnapshot = !client;
  if (client) {
    try {
      const access = await client.from('tasks').select('id').eq('id', failed.task_id).maybeSingle();
      if (access.error) throw access.error;
      if (!access.data) throw new Error('Доступ к этапу отозван.');
      serverState = await fetchServerItem(client, failed.task_item_id);
      if (await sameUser(userId)) {
        await localCacheDriver.remove(userId, `blocked-task:${failed.task_id}`);
        await localCacheDriver.remove(userId, `blocked:${failed.project_id}`);
      }
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      useCachedSnapshot = true;
    }
  }
  if (useCachedSnapshot) {
    if (locallyBlocked) throw new Error('Доступ к этапу отозван. Локальные данные сохранены для восстановления.');
    const entry = await localCacheDriver.get(userId, `items:${failed.task_id}:active`);
    if (!entry) throw new Error('Серверный снимок недоступен. Подключитесь к сети.');
    serverState = (JSON.parse(entry.data) as ReconciledItem[]).find((row) => row.id === failed.task_item_id) ?? null;
  }
  if (!await sameUser(userId)) throw new Error('Сеанс изменился.');
  await localCacheDriver.discardFailedChain(userId, failed.task_id, failed.task_item_id, failed.project_id, serverState);
  updateSyncState(userId, { lastErrorKind: 'needs-verification' });
  announceSyncChange(userId);
}
