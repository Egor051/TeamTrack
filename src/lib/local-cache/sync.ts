import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabase, type Database } from '@/lib/supabase/client';
import { supabaseEnv } from '@/lib/env';
import { activeCacheUserId, isTransportFailure } from './cache';
import { announceConflictChange, recordConflict, unresolvedConflicts } from './conflicts';
import { localCacheDriver } from './driver';
import { listPendingOperations, offlineSyncEnabled } from './outbox';
import { validSyncVersion } from './pull-cache';
import type { OfflineOperation, PullChange, ReconciledItem, SyncConflict } from './types';

type V2Result = { status: 'applied' | 'conflict'; version: number; item: ReconciledItem };
type PullPage = { changes: PullChange[]; next_cursor: number; has_more: boolean };

const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<(userId: string) => void>();

export function subscribeSyncChanges(listener: (userId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function announceSyncChange(userId: string): void {
  for (const listener of listeners) listener(userId);
}
const sameUser = async (userId: string) => await activeCacheUserId() === userId;

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

async function bootstrapPull(client: SupabaseClient<Database>, userId: string): Promise<void> {
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
  await localCacheDriver.initializePullCursor(userId, start);
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
    const { data, error } = await client.rpc('pull_task_item_changes', { p_after_cursor: cursor, p_limit: 100 });
    if (error) throw error;
    const page = data as PullPage | null;
    if (!page || !Array.isArray(page.changes) || !Number.isSafeInteger(page.next_cursor)
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

async function push(client: SupabaseClient<Database>, userId: string, allowedConflict?: SyncConflict): Promise<void> {
  while (await sameUser(userId)) {
    if (!allowedConflict && (await unresolvedConflicts(userId)).length) return;
    const operations = await listPendingOperations(userId);
    const oldest = allowedConflict
      ? operations.find((row) => allowedConflict.operation_ids.includes(row.operation_id))
      : operations[0];
    if (!oldest || oldest.status === 'failed' || oldest.status === 'conflict') return;
    if (oldest.status === 'synced_unreconciled') {
      try { await reconcile(client, oldest); } catch { return; }
      continue;
    }
    if (!validSyncVersion(oldest.expected_version)) {
      if (oldest.depends_on_operation_id) return;
      const serverState = await fetchServerItem(client, oldest.task_item_id);
      const chain = operations.filter((row) => row.task_item_id === oldest.task_item_id);
      await recordConflict({ userId, operations: chain, serverState,
        serverVersion: serverState?.sync_version ?? null, conflictId: allowedConflict?.conflict_id });
      return;
    }
    let result: V2Result | null = null;
    for (let attempt = 0; attempt < 3 && await sameUser(userId); attempt += 1) {
      try { result = await send(client, oldest); break; }
      catch (error) {
        if (!await sameUser(userId)) return;
        if (deterministicRejection(error)) {
          await localCacheDriver.markOperation(userId, oldest.operation_id, 'failed', undefined,
            (error as { message?: string }).message ?? 'Server rejected operation');
          announceSyncChange(userId);
          return;
        }
        if (!isTransportFailure(error) || attempt === 2) return;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
    if (!result || !await sameUser(userId)) return;
    if (result.status === 'conflict') {
      await recordConflict({ userId, operations: operations.filter((row) => row.task_item_id === oldest.task_item_id),
        serverState: result.item, serverVersion: result.version, conflictId: allowedConflict?.conflict_id });
      return;
    }
    await localCacheDriver.acknowledgeOperation(userId, oldest.operation_id, result.version,
      allowedConflict?.conflict_id, result.item);
    announceSyncChange(userId);
    try { await reconcile(client, oldest); } catch { return; }
  }
}

async function run(userId: string, allowedConflict?: SyncConflict): Promise<void> {
  if (!offlineSyncEnabled() || !await sameUser(userId)) return;
  const client = await clientFor(userId);
  if (!client) return;
  if (!allowedConflict) {
    try { await pull(client, userId); } catch (error) { if (!isTransportFailure(error)) throw error; return; }
  }
  if (!await sameUser(userId)) return;
  await push(client, userId, allowedConflict);
  if (allowedConflict) return;
  if (!(await unresolvedConflicts(userId)).length) {
    try { await pull(client, userId); } catch (error) { if (!isTransportFailure(error)) throw error; }
  }
}

export function syncPendingOperations(userId: string): Promise<void> {
  if (!offlineSyncEnabled()) return Promise.resolve();
  const existing = inFlight.get(userId);
  if (existing) return existing;
  const task = run(userId).finally(() => { inFlight.delete(userId); });
  inFlight.set(userId, task);
  return task;
}

export async function chooseMine(userId: string, conflictId: string): Promise<void> {
  if (!offlineSyncEnabled() || !await sameUser(userId)) throw new Error('Синхронизация недоступна.');
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
  const task = run(userId, conflict);
  inFlight.set(userId, task);
  try { await task; } finally { inFlight.delete(userId); }
  const remaining = (await listPendingOperations(userId)).filter((row) => conflict.operation_ids.includes(row.operation_id));
  if (remaining.length) throw new Error('Не удалось применить ваш вариант. Проверьте подключение и повторите.');
  await localCacheDriver.finishMineConflict(userId, conflictId);
  announceConflictChange(userId);
  announceSyncChange(userId);
  void syncPendingOperations(userId).catch(() => undefined);
}
