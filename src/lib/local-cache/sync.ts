import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { usesLocalReads } from '@/lib/connectivity/state';
import { connectivityFetch } from '@/lib/connectivity/fetch';
import { boundedOperation } from '@/lib/connectivity/deadline';
import { supabase, type Database } from '@/lib/supabase/client';
import { supabaseEnv } from '@/lib/env';
import { activeCacheUserId, getCached, isTaskProjectBlocked, isTransportFailure } from './cache';
import { announceConflictChange, recordConflict, unresolvedConflicts } from './conflicts';
import { localCacheDriver } from './driver';
import { listPendingOperations, offlineSyncEnabled } from './outbox';
import { hasMeaningfulPull, validSyncVersion } from './pull-cache';
import { RUNTIME_CONFIG_TTL_MS, runtimeCapabilities } from './runtime-config';
import { markSuccessfulSync, notifySyncState, updateSyncState } from './status';
import type { OfflineOperation, PullChange, ReconciledItem, SyncConflict, LocalCacheDriver } from './types';
import { startRuntimeOperation, cancelRuntimeOperation, getOfflineRuntime, type OperationTicket } from './runtime-state';
import { requestOfflineWork, type SyncResult } from './work-requests';
import { reconciledKeys } from './reconcile';
import { denyCacheAccess } from './access-state';
import { announceReadModelCommit } from './read-model-events';
import { nextPushOperation } from './failed-chain';
import { readAccountEpoch } from './read-freshness';
import { readSnapshotPages } from './snapshot-pages';
import { operationContext, operationReview, reviewError, type OperationResolution } from '@/lib/supabase/operation-handle';
import { annotateError, OperationError } from '@/lib/errors/operation-error';
import { reportClientError } from '@/lib/errors/error-events';

type V2Result = { status: 'applied' | 'conflict'; version: number; item: ReconciledItem };
type PullPage = { changes: PullChange[]; next_cursor: number; has_more: boolean } | { reset_required: true; retained_after_cursor: number };

const inFlight = new Map<string, Promise<SyncResult>>();
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
  // The account overview includes optimistic progress and confirmed pull/ACK
  // snapshots. Reuse its existing cross-tab commit channel for visible counts.
  announceReadModelCommit(userId, ['checklist-overview'], 'read');
}
const sameUser = async (userId: string) => await activeCacheUserId() === userId;
const SYNC_REQUEST_TIMEOUT_MS = 20_000;
type SyncContext = { ticket: OperationTicket; storage: LocalCacheDriver; wait: <T>(work: () => PromiseLike<T>) => Promise<T>;
  confirmedAt?: number; pushed?: boolean; reconciled?: boolean };
function syncContext(ticket: OperationTicket): SyncContext {
  const wait = async <T,>(work: () => PromiseLike<T>): Promise<T> => {
    ticket.assertCurrent();
    const value = await boundedOperation(work, SYNC_REQUEST_TIMEOUT_MS, ticket.signal);
    ticket.assertCurrent(); ticket.touch(); return value;
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
    .then((value) => { ctx?.ticket.assertCurrent(); ctx?.ticket.touch(); return value; });
}
async function quarantineTask(userId: string, taskId: string, ctx: SyncContext): Promise<void> {
  if (!await ctx.wait(() => sameUser(userId))) throw new Error('Сеанс изменился.');
  denyCacheAccess(userId, `blocked-task:${taskId}`);
  await ctx.storage.put({ user_id: userId, key: `blocked-task:${taskId}`, data: 'true',
    last_synced_at: new Date().toISOString(), schema_version: 1 });
}
export function cancelPendingSync(userId: string): void {
  cancelRuntimeOperation(userId, 'sync'); clearRetry(userId); rerunRequested.delete(userId);
  syncTickets.delete(userId); inFlight.delete(userId);
}

function scheduleRetry(userId: string, until: number): void {
  if (requestOfflineWork(userId, 'sync-retry', Math.max(25, until - Date.now()))) {
    clearRetry(userId); return;
  }
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

export function pendingSyncDelay(userId: string): number {
  return Math.max(0, (backoff.get(userId)?.until ?? 0) - Date.now());
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
  if (operation.protocol_version && operation.protocol_version > 3) throw new Error('Unsupported local protocol version');
  if (!['set_task_item_state', 'set_task_item_percentage', 'set_task_item_comment'].includes(operation.type))
    throw new Error('Unsupported local operation type');
  if (!validSyncVersion(operation.expected_version)) throw new Error('Operation has no confirmed server version');
  if (operation.protocol_version === 3 && !operation.operation_handle) {
    const context = await syncRead(client.rpc('get_client_operation_context'), ctx);
    if (context.error) throw annotateError(context.error, { stage: 'sync_context' });
    operation = await ctx.storage.bindOperationHandle(operation.user_id, operation.operation_id,
      { ...operationContext(context.data), id: operation.operation_id });
  }
  if (!validSyncVersion(operation.expected_version)) throw new Error('Bound operation has no confirmed server version');
  const common = { p_operation_id: operation.operation_id, p_task_item_id: operation.task_item_id,
    p_expected_version: operation.expected_version };
  const v3 = operation.operation_handle;
  if (operation.protocol_version === 3 && !v3) throw new Error('Missing durable operation handle');
  const window = v3 ? { p_generation: v3.generation, p_epoch: v3.epoch } : null;
  ctx.pushed = true;
  const response = await syncRead(window ? (operation.type === 'set_task_item_state'
    ? client.rpc('apply_task_item_state_operation_v3', { ...common, ...window, p_completed: (operation.payload as { completed: boolean }).completed })
    : operation.type === 'set_task_item_percentage'
      ? client.rpc('apply_task_item_percentage_operation_v3', { ...common, ...window, p_percentage: (operation.payload as { percentage: number }).percentage })
      : client.rpc('apply_task_item_comment_operation_v3', { ...common, ...window, p_comment: (operation.payload as { comment: string | null }).comment ?? '' }))
    : operation.type === 'set_task_item_state'
    ? client.rpc('apply_task_item_state_operation_v2', { ...common,
      p_completed: (operation.payload as { completed: boolean }).completed })
    : operation.type === 'set_task_item_percentage'
      ? client.rpc('apply_task_item_percentage_operation_v2', { ...common,
        p_percentage: (operation.payload as { percentage: number }).percentage })
      : client.rpc('apply_task_item_comment_operation_v2', { ...common,
        p_comment: (operation.payload as { comment: string | null }).comment ?? '' }), ctx);
  if (response.error) throw annotateError(response.error, { stage: 'sync_send' });
  if ((response.data as { state?: string } | null)?.state === 'result_redacted') throw reviewError('TT_OPERATION_RESULT_REDACTED');
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

async function taskSnapshot(client: SupabaseClient<Database>, taskId: string, ctx: SyncContext,
  mode: 'all' | 'active' | 'archived' = 'all'): Promise<ReconciledItem[]> {
  return readSnapshotPages<ReconciledItem>((offset, revision) => syncRead(client.rpc('get_task_item_snapshot_page', {
    p_task_id: taskId, p_mode: mode, p_offset: offset, p_limit: 500, p_revision: revision ?? undefined,
  }), ctx));
}

async function reconcile(client: SupabaseClient<Database>, operation: OfflineOperation, ctx: SyncContext): Promise<void> {
  ctx.reconciled = true;
  if (!await ctx.wait(() => sameUser(operation.user_id))) throw new Error('Session changed');
  const before = await ctx.storage.listEntries(operation.user_id);
  const guards = [...reconciledKeys(operation), 'sync:task-items:cursor'].map((key) => ({ key, data: before.find((entry) => entry.key === key)?.data ?? null }));
  const access = await syncRead(client.from('tasks').select('id').eq('id', operation.task_id).maybeSingle(), ctx);
  if (access.error) throw access.error;
  if (!access.data) {
    await quarantineTask(operation.user_id, operation.task_id, ctx);
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
    const rows = await taskSnapshot(client, taskId, ctx, mode as 'all' | 'active' | 'archived');
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

async function moveToReview(operation: OfflineOperation, reason: string, ctx: SyncContext, conflict?: SyncConflict) {
  await ctx.storage.markOperation(operation.user_id, operation.operation_id, 'review', operation.server_result, reason, conflict?.conflict_id);
  if (conflict) announceConflictChange(operation.user_id);
  announceSyncChange(operation.user_id);
}

async function push(client: SupabaseClient<Database>, userId: string, ctx: SyncContext, allowedConflict?: SyncConflict): Promise<boolean> {
  let completed = 0;
  let total: number | null = null;
  pushLoop: while (await ctx.wait(() => sameUser(userId))) {
    if (!allowedConflict && (await ctx.wait(() => unresolvedConflicts(userId))).length) return false;
    const operations = await ctx.wait(() => listPendingOperations(userId));
    total ??= operations.length;
    updateSyncState(userId, { progress: { done: completed, total } }, ctx.ticket);
    const oldest = allowedConflict
      ? operations.find((row) => allowedConflict.operation_ids.includes(row.operation_id))
      : nextPushOperation(operations);
    if (!oldest) return operations.length === 0;
    if (oldest.status === 'review') {
      if (allowedConflict) await moveToReview(oldest, oldest.last_error ?? 'TT_OPERATION_LEGACY_REVIEW', ctx, allowedConflict);
      return false;
    }
    if (oldest.status === 'failed' || oldest.status === 'conflict') return false;
    updateSyncState(userId, { isSyncing: true }, ctx.ticket);
    if ((oldest.protocol_version && oldest.protocol_version > 3)
      || !['set_task_item_state', 'set_task_item_percentage', 'set_task_item_comment'].includes(oldest.type)) {
      await ctx.storage.markOperation(userId, oldest.operation_id, 'failed', undefined, 'Требуется новая версия приложения.');
      announceSyncChange(userId);
      continue;
    }
    if (oldest.status === 'synced_unreconciled') {
      try { await reconcile(client, oldest, ctx); completed += 1; } catch { return false; }
      continue;
    }
    // A v1 receipt has no acknowledged CAS version. Do not reinterpret that
    // old UUID as a v2/v3 write or guess a predecessor version from live data.
    if ((oldest.protocol_version ?? 1) < 2) {
      await moveToReview(oldest, 'TT_OPERATION_LEGACY_REVIEW', ctx, allowedConflict);
      if (allowedConflict) return false;
      continue;
    }
    if (!ctx.confirmedAt || Date.now() - ctx.confirmedAt >= RUNTIME_CONFIG_TTL_MS || (completed > 0 && completed % 20 === 0)) {
      if (!(await ctx.wait(() => runtimeCapabilities(userId, true, { requireServer: true }))).sync) {
        updateSyncState(userId, { lastErrorKind: 'disabled' }, ctx.ticket); return false;
      }
      ctx.confirmedAt = Date.now();
    }
    if (!validSyncVersion(oldest.expected_version)) {
      if (oldest.depends_on_operation_id) {
        await ctx.storage.markOperation(userId, oldest.operation_id, 'failed', undefined, 'Не найдена подтверждённая предыдущая операция.');
        announceSyncChange(userId);
        continue;
      }
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
        reportClientError(error, { stage: 'sync_send', operation: oldest.type, userId,
          taskId: oldest.task_id, itemId: oldest.task_item_id, displayedVersion: oldest.expected_version ?? undefined });
        if (!await ctx.wait(() => sameUser(userId))) return false;
        const protocolCode = operationReview(error as { code?: string; details?: string })
          ?? (error as { details?: string; code?: string })?.details ?? (error as { code?: string })?.code;
        if (protocolCode?.startsWith('TT_OPERATION_')) {
          await moveToReview(oldest, protocolCode, ctx, allowedConflict);
          if (allowedConflict) return false;
          continue pushLoop;
        }
        if (deterministicRejection(error)) {
          await ctx.storage.markOperation(userId, oldest.operation_id, 'failed', undefined,
            (error as { message?: string }).message ?? 'Server rejected operation');
          if ((error as { code?: string }).code === '42501') {
            const access = await syncRead(client.from('tasks').select('id').eq('id', oldest.task_id).maybeSingle(), ctx);
            if ((!access.error && !access.data) || access.error?.code === '42501') await quarantineTask(userId, oldest.task_id, ctx);
          }
          announceSyncChange(userId);
          continue pushLoop;
        }
        if (!isTransportFailure(error) || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
    if (!result || !await ctx.wait(() => sameUser(userId))) return false;
    if (result.status === 'conflict') {
      reportClientError(new OperationError('conflict', 'PT409', 'sync_send'), { operation: oldest.type, userId,
        taskId: oldest.task_id, itemId: oldest.task_item_id, displayedVersion: oldest.expected_version ?? undefined, serverVersion: result.version });
      await ctx.wait(() => recordConflict({ userId, operations: operations.filter((row) => row.task_item_id === oldest.task_item_id),
        serverState: result.item, serverVersion: result.version, conflictId: allowedConflict?.conflict_id }, ctx.storage));
      return false;
    }
    await ctx.storage.acknowledgeOperation(userId, oldest.operation_id, result.version,
      allowedConflict?.conflict_id, result.item).catch(error => {
        reportClientError(error, { stage: 'sync_ack', operation: oldest.type, userId, taskId: oldest.task_id, itemId: oldest.task_item_id });
        throw error;
      });
    announceSyncChange(userId);
    try { await reconcile(client, oldest, ctx); completed += 1; } catch { return false; }
  }
  return false;
}

async function run(userId: string, ctx: SyncContext, allowedConflict?: SyncConflict): Promise<boolean> {
  if (!offlineSyncEnabled() || !await ctx.wait(() => sameUser(userId))) return false;
  const replay = !!allowedConflict || (await ctx.wait(() => listPendingOperations(userId))).some((row) => row.status === 'pending');
  const capabilities = await ctx.wait(() => runtimeCapabilities(userId, false, { requireServer: replay }));
  if (replay && capabilities.sync) ctx.confirmedAt = Date.now();
  if (!capabilities.sync) {
    updateSyncState(userId, { lastErrorKind: capabilities.available ? 'disabled' : 'config-unavailable' }, ctx.ticket);
    const failures = capabilities.available ? 0 : Math.min((backoff.get(userId)?.failures ?? 0) + 1, 5);
    const delay = capabilities.available ? RUNTIME_CONFIG_TTL_MS : Math.min(60_000, 5_000 * 2 ** (failures - 1));
    const until = Date.now() + delay;
    backoff.set(userId, { failures, until });
    if (!capabilities.available || (await ctx.wait(() => listPendingOperations(userId)))
      .some((row) => row.status === 'pending' || row.status === 'synced_unreconciled')) scheduleRetry(userId, until);
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
  if (ctx.pushed || ctx.reconciled) await pull(client, userId, ctx);
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

export function syncPendingOperations(userId: string, manual = false): Promise<SyncResult> {
  if (!offlineSyncEnabled()) return Promise.resolve({ outcome: 'disabled', error: null });
  const existing = inFlight.get(userId);
  if (existing) return existing;
  if (!manual && Date.now() < (backoff.get(userId)?.until ?? 0)) {
    scheduleRetry(userId, backoff.get(userId)!.until);
    return Promise.resolve({ outcome: 'partial', error: getOfflineRuntime(userId).syncError });
  }
  const ticket = startRuntimeOperation(userId, 'sync', 'refresh', 5 * 60_000);
  syncTickets.set(userId, ticket);
  const ctx = syncContext(ticket);
  const result: SyncResult = { outcome: 'partial', error: null };
  const task = boundedOperation(async () => {
    updateSyncState(userId, { lastErrorKind: null }, ticket);
    try {
      const succeeded = await coordinatedRun(userId, ctx);
      if (succeeded) { result.outcome = 'success'; backoff.delete(userId); clearRetry(userId); }
      else if (await ctx.wait(() => sameUser(userId))) {
        const operations = await ctx.wait(() => listPendingOperations(userId));
        const conflicts = await ctx.wait(() => unresolvedConflicts(userId));
        const error = getOfflineRuntime(userId).syncError;
        result.outcome = usesLocalReads() ? 'waiting-network' : operations.some((row) => row.status === 'failed' || row.status === 'conflict')
          || operations.some(row => row.status === 'review') || conflicts.length ? 'blocked' : error === 'disabled' ? 'disabled' : 'partial';
        result.error = error === 'config-unavailable' ? 'Не удалось проверить доступность синхронизации.'
          : error === 'auth' ? 'Требуется авторизация.' : null;
        if (nextPushOperation(operations)
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
    if (ticket.signal.aborted) { result.outcome = 'partial'; return; }
    ticket.finish('error', error instanceof Error ? error.message : 'Sync failed'); throw error;
  }).finally(() => {
    if (inFlight.get(userId) === task) inFlight.delete(userId);
    if (syncTickets.get(userId) === ticket) syncTickets.delete(userId);
  }).then(() => result);
  inFlight.set(userId, task);
  return task;
}

export async function chooseMine(userId: string, conflictId: string): Promise<void> {
  let released = false;
  try {
    await queueAction(userId, async ctx => {
      if (!offlineSyncEnabled() || !(await ctx.wait(() => runtimeCapabilities(userId, true, { requireServer: true }))).sync)
        throw new Error('Синхронизация временно отключена. Ваш вариант сохранён на устройстве.');
      // Read again only after the existing sync/account/cross-tab fence is held.
      const previous = (await ctx.wait(() => unresolvedConflicts(userId))).find(row => row.conflict_id === conflictId);
      if (!previous) return; // Another queued action already completed it.
      const chain = (await ctx.wait(() => listPendingOperations(userId))).filter(row => previous.operation_ids.includes(row.operation_id));
      const first = chain.find(row => row.status !== 'synced_unreconciled');
      if (first?.status === 'review') {
        await moveToReview(first, first.last_error ?? 'TT_OPERATION_LEGACY_REVIEW', ctx, previous);
        released = true; throw reviewError(first.last_error ?? 'TT_OPERATION_LEGACY_REVIEW');
      }
      if (first?.status === 'conflict') {
        if (!validSyncVersion(previous.server_version)) throw new Error('Серверный пункт удалён. Оставьте серверное состояние.');
        await ctx.storage.rebaseConflict(userId, conflictId, previous.server_version);
      }
      // Pending (possibly committed) and ACKed attempts resume unchanged.
      const conflict = (await ctx.wait(() => unresolvedConflicts(userId))).find(row => row.conflict_id === conflictId);
      if (!conflict) return;
      await run(userId, ctx, conflict);
      const remaining = (await ctx.wait(() => listPendingOperations(userId))).filter(row => conflict.operation_ids.includes(row.operation_id));
      if (remaining.length) {
        if (remaining.some(row => row.status === 'review')) {
          released = true; throw reviewError(remaining.find(row => row.status === 'review')!.last_error ?? 'TT_OPERATION_LEGACY_REVIEW');
        }
        throw new Error('Не удалось применить ваш вариант. Проверьте подключение и повторите.');
      }
      await ctx.storage.finishMineConflict(userId, conflictId);
      announceConflictChange(userId); announceSyncChange(userId); released = true;
    });
  } finally {
    if (released) void syncPendingOperations(userId).catch(() => undefined);
  }
}

// Recovery actions share the existing sync serialization and cross-tab lock.
// Register before the first await so two button presses cannot both start work.
function queueAction(userId: string, action: (ctx: SyncContext) => Promise<void>): Promise<void> {
  const previous = inFlight.get(userId);
  const epoch = getOfflineRuntime(userId).epoch, accountEpoch = readAccountEpoch();
  const work = Promise.resolve().then(async () => {
    if (previous) await previous.catch(() => undefined);
    if (epoch !== getOfflineRuntime(userId).epoch || accountEpoch !== readAccountEpoch() || !await sameUser(userId))
      throw new Error('Сеанс изменился.');
    const ticket = startRuntimeOperation(userId, 'sync', 'synchronization', 5 * 60_000);
    syncTickets.set(userId, ticket);
    const ctx = syncContext(ticket);
    const guarded = async () => {
      ticket.assertCurrent();
      if (accountEpoch !== readAccountEpoch() || !await ctx.wait(() => sameUser(userId))) throw new Error('Сеанс изменился.');
      await action(ctx);
    };
    try {
      await boundedOperation(() => typeof navigator !== 'undefined' && navigator.locks?.request
        ? navigator.locks.request(`tasktrace-sync:${userId}`, { signal: ticket.signal }, guarded) : guarded(), 5 * 60_000, ticket.signal);
      ticket.finish('partial');
    } catch (error) { ticket.finish('error', (error as Error)?.message); throw error; }
    finally { if (syncTickets.get(userId) === ticket) syncTickets.delete(userId); }
  });
  const task = work.then((): SyncResult => ({ outcome: 'partial', error: null })).finally(() => {
    if (inFlight.get(userId) === task) inFlight.delete(userId);
  });
  inFlight.set(userId, task);
  return task.then(() => undefined);
}

export async function retryFailedOperation(userId: string, operationId: string): Promise<void> {
  await queueAction(userId, async (ctx) => {
    if (!(await ctx.wait(() => runtimeCapabilities(userId, true, { requireServer: true }))).sync || !await ctx.wait(() => sameUser(userId)))
      throw new Error('Синхронизация временно отключена.');
    const operations = await ctx.wait(() => listPendingOperations(userId));
    const failed = operations.find((row) => row.operation_id === operationId && row.status === 'failed');
    if (!failed) throw new Error('Неудавшееся изменение не найдено.');
    const client = await clientFor(userId, ctx);
    if (!client) throw new Error('Требуется авторизация.');
    const access = await syncRead(client.from('tasks').select('id').eq('id', failed.task_id).maybeSingle(), ctx);
    if (access.error) throw access.error;
    if (!access.data) throw new Error('Доступ к этапу отозван.');
    const serverState = await fetchServerItem(client, failed.task_item_id, ctx);
    if (!serverState || !validSyncVersion(serverState.sync_version)
      || serverState.sync_version !== failed.expected_version || serverState.is_archived) {
      await ctx.wait(() => recordConflict({ userId, operations: operations.filter((row) => row.task_item_id === failed.task_item_id),
        serverState, serverVersion: serverState?.sync_version ?? null }, ctx.storage));
      announceSyncChange(userId);
      return;
    }
    if (!await ctx.wait(() => sameUser(userId))) throw new Error('Сеанс изменился.');
    await ctx.storage.remove(userId, `blocked-task:${failed.task_id}`);
    await ctx.storage.markOperation(userId, operationId, 'pending');
    announceSyncChange(userId);
  });
  // A queued cancel may reject because this retry already made the row pending.
  // Its UI error belongs to that action, not to the authorized replay.
  while (inFlight.has(userId)) await inFlight.get(userId)!.catch(() => undefined);
  await syncPendingOperations(userId, true);
}

/** Read-only resolution; expiry never calls a mutation or allocates a new ID. */
export async function inspectReviewOperation(userId: string, operationId: string) {
  const snapshot: { value: { state: string; server: ReconciledItem | null } | null } = { value: null };
  await queueAction(userId, async ctx => {
    const operation = (await ctx.wait(() => listPendingOperations(userId))).find(row => row.operation_id === operationId && row.status === 'review');
    if (!operation) throw new Error('Изменение уже согласовано. Обновите состояние.');
    const client = await clientFor(userId, ctx);
    if (!client) throw new Error('Требуется авторизация.');
    const payload = operation.type === 'set_task_item_comment' ? { comment: (operation.payload as { comment: string | null }).comment ?? '' } : operation.payload;
    const h = operation.operation_handle;
    const response = await syncRead(h ? client.rpc('resolve_client_operation_v3', {
      p_generation: h.generation, p_epoch: h.epoch, p_operation_id: operationId, p_type: operation.type,
      p_target: operation.task_item_id, p_payload: { payload, expected_version: operation.expected_version },
    }) : client.rpc('resolve_legacy_client_operation', { p_operation_id: operationId,
      p_type: operation.type + ((operation.protocol_version ?? 1) >= 2 ? '_v2' : ''), p_target: operation.task_item_id, p_payload: payload }), ctx);
    if (response.error) throw response.error;
    const resolution = response.data as OperationResolution;
    const server = await fetchServerItem(client, operation.task_item_id, ctx);
    snapshot.value = { state: resolution.state, server };
    // Only a real receipt can turn an unknown result into an ACK.
    if (resolution.state === 'completed') {
      const result = (h ? resolution.result?.value : resolution.result) as V2Result | undefined;
      if (result?.status === 'applied' && validSyncVersion(result.version)) {
        await ctx.storage.acknowledgeOperation(userId, operationId, result.version);
        await reconcile(client, operation, ctx);
      }
    }
    announceSyncChange(userId);
  });
  return snapshot.value;
}

export async function discardFailedOperation(userId: string, operationId: string): Promise<void> {
  await queueAction(userId, async (ctx) => {
    const operations = await ctx.wait(() => listPendingOperations(userId));
    const operation = operations.find((row) => row.operation_id === operationId);
    if (!operation) return; // Repeat cancellation, including after a restart.
    if (operation.status !== 'failed' && operation.status !== 'review') throw new Error('Изменение уже отправляется. Обновите состояние синхронизации.');
    const failed = operation;
    const chain = operations.filter((row) => row.task_id === failed.task_id && row.task_item_id === failed.task_item_id);
    const locallyBlocked = await ctx.wait(() => getCached<boolean>(userId, `blocked-task:${failed.task_id}`))
      || await ctx.wait(() => isTaskProjectBlocked(userId, failed.task_id, failed.project_id));
    const client = locallyBlocked ? null : await clientFor(userId, ctx);
    if (failed.status === 'review' && !locallyBlocked && (!client || usesLocalReads())) throw new Error('Для согласования требуется получить актуальное состояние сервера.');
    let serverState: ReconciledItem | null = null;
    let useCachedSnapshot = !client && !locallyBlocked;
    if (client) {
      try {
        const access = await syncRead(client.from('tasks').select('id').eq('id', failed.task_id).maybeSingle(), ctx);
        if (access.error) throw access.error;
        if (!access.data) {
          await quarantineTask(userId, failed.task_id, ctx);
        } else {
          serverState = await fetchServerItem(client, failed.task_item_id, ctx);
        }
      } catch (error) {
        if ((error as { code?: string })?.code === '42501') {
          await quarantineTask(userId, failed.task_id, ctx);
          serverState = null;
        } else {
          if (failed.status === 'review' || !isTransportFailure(error)) throw error;
          useCachedSnapshot = true;
        }
      }
    }
    if (useCachedSnapshot) {
      const entry = await ctx.storage.get(userId, `items:${failed.task_id}:active`);
      serverState = entry ? (JSON.parse(entry.data) as ReconciledItem[]).find((row) => row.id === failed.task_item_id) ?? null : null;
    }
    if (!await ctx.wait(() => sameUser(userId))) throw new Error('Сеанс изменился.');
    await ctx.storage.discardFailedChain(userId, failed.task_id, failed.task_item_id, failed.project_id, serverState, chain);
    updateSyncState(userId, { lastErrorKind: 'needs-verification' });
    announceSyncChange(userId);
  });
  void syncPendingOperations(userId).catch(() => undefined);
}
