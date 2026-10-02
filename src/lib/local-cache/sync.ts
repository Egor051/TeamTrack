import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabase, type Database } from '@/lib/supabase/client';
import { supabaseEnv } from '@/lib/env';
import { activeCacheUserId, getCached, isTransportFailure } from './cache';
import { announceConflictChange, recordConflict, unresolvedConflicts } from './conflicts';
import { localCacheDriver } from './driver';
import { listPendingOperations, offlineSyncEnabled } from './outbox';
import { validSyncVersion } from './pull-cache';
import { RUNTIME_CONFIG_TTL_MS, runtimeCapabilities } from './runtime-config';
import { markSuccessfulSync, notifySyncState, updateSyncState } from './status';
import type { OfflineOperation, PullChange, ReconciledItem, SyncConflict } from './types';

type V2Result = { status: 'applied' | 'conflict'; version: number; item: ReconciledItem };
type PullPage = { changes: PullChange[]; next_cursor: number; has_more: boolean } | { reset_required: true; retained_after_cursor: number };

const inFlight = new Map<string, Promise<void>>();
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

function scheduleRetry(userId: string, until: number): void {
  const existing = retryTimers.get(userId);
  if (existing && existing.until <= until) return;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    retryTimers.delete(userId);
    void sameUser(userId).then((active) => {
      if (active) void syncPendingOperations(userId).catch(() => undefined);
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

async function clientFor(userId: string): Promise<SupabaseClient<Database> | null> {
  const { data, error } = await supabase.auth.getSession();
  const session = data.session;
  if (error || !session || session.user.id !== userId ||
    (session.expires_at && session.expires_at * 1000 <= Date.now())) return null;
  const { url, anonKey } = supabaseEnv();
  return createClient<Database>(url, anonKey, {
    accessToken: async () => session.access_token,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function send(client: SupabaseClient<Database>, operation: OfflineOperation): Promise<V2Result> {
  if (operation.protocol_version && operation.protocol_version > 2) throw new Error('Unsupported local protocol version');
  if (!['set_task_item_state', 'set_task_item_percentage', 'set_task_item_comment'].includes(operation.type))
    throw new Error('Unsupported local operation type');
  if (!validSyncVersion(operation.expected_version)) throw new Error('Operation has no confirmed server version');
  const common = { p_operation_id: operation.operation_id, p_task_item_id: operation.task_item_id,
    p_expected_version: operation.expected_version };
  const response = operation.type === 'set_task_item_state'
    ? await client.rpc('apply_task_item_state_operation_v2', { ...common,
      p_completed: (operation.payload as { completed: boolean }).completed })
    : operation.type === 'set_task_item_percentage'
      ? await client.rpc('apply_task_item_percentage_operation_v2', { ...common,
        p_percentage: (operation.payload as { percentage: number }).percentage })
      : await client.rpc('apply_task_item_comment_operation_v2', { ...common,
        p_comment: (operation.payload as { comment: string | null }).comment ?? '' });
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

async function taskSnapshot(client: SupabaseClient<Database>, taskId: string): Promise<ReconciledItem[]> {
  const rows: ReconciledItem[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await client.from('task_items').select('*').eq('task_id', taskId)
      .eq('is_archived', false).order('position').order('id').range(from, from + 499);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 500) break;
  }
  return rows;
}

async function reconcile(client: SupabaseClient<Database>, operation: OfflineOperation): Promise<void> {
  if (!await sameUser(operation.user_id)) throw new Error('Session changed');
  const snapshot = await taskSnapshot(client, operation.task_id);
  const item = snapshot.find((row) => row.id === operation.task_item_id);
  if (!item) throw new Error('Confirmed task item is unavailable');
  if (!await sameUser(operation.user_id)) throw new Error('Session changed');
  await localCacheDriver.reconcileOperation(operation.user_id, operation.operation_id, item, snapshot);
  announceSyncChange(operation.user_id);
}

async function fetchServerItem(client: SupabaseClient<Database>, itemId: string): Promise<ReconciledItem | null> {
  const { data, error } = await client.from('task_items').select('*').eq('id', itemId).maybeSingle();
  if (error) throw error;
  return data;
}

async function bootstrapPull(client: SupabaseClient<Database>, userId: string, previousCursor?: import('./types').CacheEntry): Promise<void> {
  const { data, error } = await client.rpc('get_task_item_sync_cursor');
  if (error) throw error;
  const start = Number(data);
  if (!Number.isSafeInteger(start) || start < 0) throw new Error('Invalid starting sync cursor');
  // Refresh only task-item lists already present in the local confirmed cache.
  // Changes committed during this refresh are replayed from the earlier cursor.
  const entries = await localCacheDriver.listEntries(userId, 'items:');
  for (const entry of entries) {
    if (!await sameUser(userId)) return;
    const match = /^items:([^:]+):(active|archived|all)$/.exec(entry.key);
    if (!match) continue;
    const [, taskId, mode] = match;
    const taskResult = await client.from('tasks').select('id').eq('id', taskId).maybeSingle();
    if (taskResult.error) throw taskResult.error;
    if (!taskResult.data) { await localCacheDriver.remove(userId, entry.key); continue; }
    const rows: ReconciledItem[] = [];
    for (let from = 0; ; from += 500) {
      let query = client.from('task_items').select('*').eq('task_id', taskId).order('position').range(from, from + 499);
      if (mode !== 'all') query = query.eq('is_archived', mode === 'archived');
      const { data: page, error: pageError } = await query;
      if (pageError) throw pageError;
      rows.push(...(page ?? []));
      if (!page || page.length < 500) break;
    }
    await localCacheDriver.putIfUnchanged({ ...entry, data: JSON.stringify(rows),
      last_synced_at: new Date().toISOString() }, entry.data);
  }
  if (!await sameUser(userId)) return;
  if (previousCursor) {
    await localCacheDriver.putIfUnchanged({ ...previousCursor, data: JSON.stringify(start),
      last_synced_at: new Date().toISOString() }, previousCursor.data);
  } else await localCacheDriver.initializePullCursor(userId, start);
}

async function pull(client: SupabaseClient<Database>, userId: string): Promise<void> {
  let entry = await localCacheDriver.get(userId, 'sync:task-items:cursor');
  if (!entry) {
    await bootstrapPull(client, userId);
    entry = await localCacheDriver.get(userId, 'sync:task-items:cursor');
  }
  if (!entry) return;
  let cursor = Number(JSON.parse(entry.data));
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid local sync cursor');
  for (let pageIndex = 0; pageIndex < 10000 && await sameUser(userId); pageIndex += 1) {
    const { data, error } = await client.rpc('pull_task_item_changes_v2', { p_after_cursor: cursor, p_limit: 100 });
    if (error) throw error;
    const page = data as PullPage | null;
    if (page && 'reset_required' in page && page.reset_required === true) {
      if (!Number.isSafeInteger(page.retained_after_cursor) || page.retained_after_cursor <= cursor)
        throw new Error('Invalid cursor reset response');
      await bootstrapPull(client, userId, entry);
      entry = await localCacheDriver.get(userId, 'sync:task-items:cursor');
      if (!entry) throw new Error('Cursor reset failed');
      cursor = Number(JSON.parse(entry.data));
      pageIndex = -1;
      continue;
    }
    if (!page || !('changes' in page) || !Array.isArray(page.changes) || !Number.isSafeInteger(page.next_cursor)
      || page.next_cursor < cursor || typeof page.has_more !== 'boolean') throw new Error('Invalid pull page');
    if (!await sameUser(userId)) return;
    const applied = await localCacheDriver.applyPullPage(userId, cursor, page.next_cursor, page.changes);
    if (!applied) return; // Another tab advanced the cursor; its transaction owns the page.
    cursor = page.next_cursor;
    if (page.changes.length) announceSyncChange(userId);
    if (!page.has_more) return;
  }
  throw new Error('Pull page limit exceeded');
}

async function push(client: SupabaseClient<Database>, userId: string, allowedConflict?: SyncConflict): Promise<boolean> {
  let completed = 0;
  let total: number | null = null;
  while (await sameUser(userId)) {
    if (!allowedConflict && (await unresolvedConflicts(userId)).length) return false;
    const operations = await listPendingOperations(userId);
    total ??= operations.length;
    updateSyncState(userId, { progress: { done: completed, total } });
    if (completed % 20 === 0 && !(await runtimeCapabilities(userId, true, { requireServer: true })).sync) {
      updateSyncState(userId, { lastErrorKind: 'disabled' });
      return false;
    }
    const oldest = allowedConflict
      ? operations.find((row) => allowedConflict.operation_ids.includes(row.operation_id))
      : operations[0];
    if (!oldest) return true;
    if (oldest.status === 'failed' || oldest.status === 'conflict') return false;
    if ((oldest.protocol_version && oldest.protocol_version > 2)
      || !['set_task_item_state', 'set_task_item_percentage', 'set_task_item_comment'].includes(oldest.type)) {
      await localCacheDriver.markOperation(userId, oldest.operation_id, 'failed', undefined, 'Требуется новая версия приложения.');
      announceSyncChange(userId);
      return false;
    }
    if (oldest.status === 'synced_unreconciled') {
      try { await reconcile(client, oldest); completed += 1; } catch { return false; }
      continue;
    }
    if (!validSyncVersion(oldest.expected_version)) {
      if (oldest.depends_on_operation_id) return false;
      const serverState = await fetchServerItem(client, oldest.task_item_id);
      const chain = operations.filter((row) => row.task_item_id === oldest.task_item_id);
      await recordConflict({ userId, operations: chain, serverState,
        serverVersion: serverState?.sync_version ?? null, conflictId: allowedConflict?.conflict_id });
      return false;
    }
    let result: V2Result | null = null;
    for (let attempt = 0; attempt < 3 && await sameUser(userId); attempt += 1) {
      try { result = await send(client, oldest); break; }
      catch (error) {
        if (!await sameUser(userId)) return false;
        if (deterministicRejection(error)) {
          await localCacheDriver.markOperation(userId, oldest.operation_id, 'failed', undefined,
            (error as { message?: string }).message ?? 'Server rejected operation');
          if ((error as { code?: string }).code === '42501') {
            const access = await client.from('tasks').select('id').eq('id', oldest.task_id).maybeSingle();
            if (!access.error && !access.data && await sameUser(userId))
              await localCacheDriver.put({ user_id: userId, key: `blocked-task:${oldest.task_id}`,
                data: 'true', last_synced_at: new Date().toISOString(), schema_version: 1 });
          }
          announceSyncChange(userId);
          return false;
        }
        if (!isTransportFailure(error) || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
    if (!result || !await sameUser(userId)) return false;
    if (result.status === 'conflict') {
      await recordConflict({ userId, operations: operations.filter((row) => row.task_item_id === oldest.task_item_id),
        serverState: result.item, serverVersion: result.version, conflictId: allowedConflict?.conflict_id });
      return false;
    }
    await localCacheDriver.acknowledgeOperation(userId, oldest.operation_id, result.version,
      allowedConflict?.conflict_id, result.item);
    announceSyncChange(userId);
    try { await reconcile(client, oldest); completed += 1; } catch { return false; }
  }
  return false;
}

async function run(userId: string, allowedConflict?: SyncConflict): Promise<boolean> {
  if (!offlineSyncEnabled() || !await sameUser(userId)) return false;
  const capabilities = await runtimeCapabilities(userId, true, { requireServer: true });
  if (!capabilities.sync) {
    updateSyncState(userId, { lastErrorKind: capabilities.available ? 'disabled' : 'config-unavailable' });
    const failures = capabilities.available ? 0 : Math.min((backoff.get(userId)?.failures ?? 0) + 1, 5);
    const delay = capabilities.available ? RUNTIME_CONFIG_TTL_MS : Math.min(60_000, 5_000 * 2 ** (failures - 1));
    const until = Date.now() + delay;
    backoff.set(userId, { failures, until });
    scheduleRetry(userId, until);
    return false;
  }
  const client = await clientFor(userId);
  if (!client) {
    const until = Date.now() + 30_000;
    backoff.set(userId, { failures: 0, until });
    scheduleRetry(userId, until);
    updateSyncState(userId, { lastErrorKind: 'auth' });
    return false;
  }
  if (!allowedConflict) {
    await pull(client, userId);
  }
  if (!await sameUser(userId)) return false;
  const pushed = await push(client, userId, allowedConflict);
  if (allowedConflict) return pushed;
  if (!await sameUser(userId)) return false;
  await pull(client, userId);
  if (!await sameUser(userId)) return false;
  const remaining = await listPendingOperations(userId);
  const conflicts = await unresolvedConflicts(userId);
  if (pushed && !remaining.length && !conflicts.length) {
    await markSuccessfulSync(userId);
    return true;
  }
  return false;
}

async function coordinatedRun(userId: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const until = Date.now() + 30_000;
    backoff.set(userId, { failures: 0, until });
    scheduleRetry(userId, until);
    updateSyncState(userId, { connectivity: 'offline', lastErrorKind: 'transport' });
    return false;
  }
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(`tasktrace-sync:${userId}`, async () => run(userId));
  }
  return run(userId);
}

export function syncPendingOperations(userId: string, manual = false): Promise<void> {
  if (!offlineSyncEnabled()) return Promise.resolve();
  const existing = inFlight.get(userId);
  if (existing) { rerunRequested.add(userId); return existing; }
  if (!manual && Date.now() < (backoff.get(userId)?.until ?? 0)) {
    scheduleRetry(userId, backoff.get(userId)!.until);
    return Promise.resolve();
  }
  const task = (async () => {
    updateSyncState(userId, { isSyncing: true, lastErrorKind: null });
    try {
      let succeeded = await coordinatedRun(userId);
      if (rerunRequested.delete(userId) && await sameUser(userId)) succeeded = await coordinatedRun(userId);
      if (succeeded) { backoff.delete(userId); clearRetry(userId); }
      else if (await sameUser(userId)) {
        const operations = await listPendingOperations(userId);
        if (operations.some((row) => row.status === 'pending' || row.status === 'synced_unreconciled')
          && !operations.some((row) => row.status === 'failed' || row.status === 'conflict')
          && !(await unresolvedConflicts(userId)).length)
          scheduleRetry(userId, Math.max(Date.now() + 3_000, backoff.get(userId)?.until ?? 0));
      }
    } catch (error) {
      const previous = backoff.get(userId)?.failures ?? 0;
      const failures = Math.min(previous + 1, 6);
      const until = Date.now() + Math.min(30_000, 1000 * 2 ** (failures - 1));
      backoff.set(userId, { failures, until });
      scheduleRetry(userId, until);
      updateSyncState(userId, { lastErrorKind: isTransportFailure(error) ? 'transport' : 'server' });
      throw error;
    } finally {
      updateSyncState(userId, { isSyncing: false, progress: null });
      announceSyncChange(userId);
    }
  })().finally(() => { inFlight.delete(userId); });
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
  const task = run(userId, conflict).then(() => undefined);
  inFlight.set(userId, task);
  try { await task; } finally { inFlight.delete(userId); }
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
