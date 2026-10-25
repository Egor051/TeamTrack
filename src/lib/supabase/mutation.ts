import { supabase, type Database } from './client';
import { activeCacheUserId, isTransportFailure } from '@/lib/local-cache/cache';
import { localCacheDriver } from '@/lib/local-cache/driver';
import { newAttemptId } from '@/lib/local-cache/operation-attempt';
import { boundedOperation } from '@/lib/connectivity/deadline';
import { readAccountEpoch } from '@/lib/local-cache/read-freshness';
import { usesLocalReads } from '@/lib/connectivity/state';
import { ConnectivityUnavailableError } from '@/lib/connectivity/errors';
import type { CacheEntry } from '@/lib/local-cache/types';
import type { Json } from '@/types/database.types';
import { operationContext, operationReview, reviewError, type OperationHandle, type OperationResolution } from './operation-handle';
import { announceReadModelCommit } from '@/lib/local-cache/read-model-events';

export type PendingMutation = { id: string; name: string; args: Record<string, Json | undefined>;
  phase?: 'running' | 'unknown' | 'review'; protocol_version?: 3; handle?: OperationHandle; review_reason?: string };
export type MutationOptions = { mode?: 'new' | 'retry' };
export type MutationArgs<Name extends keyof Database['public']['Functions']> = [Database['public']['Functions'][Name]['Args']] extends [never]
  ? Record<string, never> : Database['public']['Functions'][Name]['Args'];
type MutationResult<Name extends keyof Database['public']['Functions']> = {
  data: Database['public']['Functions'][Name]['Returns'] | null;
  error: { code?: string; message: string } | null;
};
const queues = new Map<string, Promise<unknown>>();
const liveIntents = new Set<string>();
// This is a tab's retry handle, not another outbox. The shared IndexedDB
// envelope and server receipt remain authoritative. sessionStorage survives a
// reload without leaving abandoned per-tab records in the shared database.
const volatileBindings = new Map<string, string>();
let tabStorage: Storage | undefined;
let storageUnavailable = false;
try { if (typeof sessionStorage !== 'undefined') tabStorage = sessionStorage; }
catch { storageUnavailable = true; }
function binding(key: string, value?: PendingMutation | null): PendingMutation | null {
  const storageKey = `tasktrace:mutation-retry:${key}`;
  try {
    if (storageUnavailable || (!tabStorage && typeof document !== 'undefined')) throw new Error('sessionStorage unavailable');
    if (value !== undefined) {
      if (value) { if (tabStorage) tabStorage.setItem(storageKey, JSON.stringify(value)); else volatileBindings.set(storageKey, JSON.stringify(value)); }
      else { if (tabStorage) tabStorage.removeItem(storageKey); else volatileBindings.delete(storageKey); }
      return value;
    }
    let data = tabStorage ? tabStorage.getItem(storageKey) : volatileBindings.get(storageKey);
    // Upgrade the tab's binding together with its new, legacy-invisible key.
    const legacyKey = storageKey.replace('sync:mutation:v3:', 'sync:mutation:');
    if (!data && legacyKey !== storageKey) {
      data = tabStorage ? tabStorage.getItem(legacyKey) : volatileBindings.get(legacyKey);
      if (data) {
        if (tabStorage) { tabStorage.setItem(storageKey, data); tabStorage.removeItem(legacyKey); }
        else { volatileBindings.set(storageKey, data); volatileBindings.delete(legacyKey); }
      }
    }
    return data ? pending({ data } as CacheEntry, JSON.parse(data).name) : null;
  } catch (cause) {
    throw Object.assign(new Error('Не удалось сохранить идентификатор действия. Разрешите хранилище вкладки и повторите.'), { code: 'TT_MUTATION_STORAGE', cause });
  }
}
const canonical = (args: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))));
function pending(entry: CacheEntry | null, name: string): PendingMutation | null {
  if (!entry) return null;
  const value = JSON.parse(entry.data) as PendingMutation;
  if (!value || value.name !== name || typeof value.id !== 'string' || !value.args || typeof value.args !== 'object' || Array.isArray(value.args))
    throw new Error('Сохранённое действие повреждено. Его нельзя безопасно повторить.');
  if (value.protocol_version !== undefined && value.protocol_version !== 3) throw reviewError('TT_OPERATION_CONTEXT');
  if (value.handle) { operationContext(value.handle); if (value.handle.id !== value.id) throw reviewError('TT_OPERATION_CONTEXT'); }
  return value;
}
function hasUnknownOutcome(error: unknown): boolean {
  if (isTransportFailure(error) || (error as Error)?.name === 'AbortError') return true;
  const value = error as { code?: string; status?: number } | null;
  if (value?.code && /^[A-Z0-9]{5}$/.test(value.code)) return false;
  return value?.status === 0 || value?.status === 408 || (value?.status ?? 0) >= 500
    || ((value?.status ?? 0) >= 200 && (value?.status ?? 0) < 300);
}
function serial<T>(userId: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(userId) ?? Promise.resolve()).catch(() => undefined).then(work);
  queues.set(userId, next);
  return next.finally(() => { if (queues.get(userId) === next) queues.delete(userId); });
}

/** Bind a retry before waiting: another tab may finish and retire its envelope. */
export function executeMutation<Name extends keyof Database['public']['Functions']>(name: Name, args: MutationArgs<Name>, options: MutationOptions = {}): Promise<MutationResult<Name>> {
  const epoch = readAccountEpoch();
  return boundedOperation(async (signal) => {
    if (usesLocalReads()) throw new ConnectivityUnavailableError();
    const assertCurrent = () => {
      if (signal.aborted || readAccountEpoch() !== epoch) throw Object.assign(new Error('Сеанс или действие изменилось.'), { name: 'AbortError' });
    };
    const identity = () => boundedOperation(() => activeCacheUserId(), 5000, signal);
    const userId = await identity();
    assertCurrent();
    if (!userId) throw new Error('Требуется авторизация.');
    const assertAccount = async () => { assertCurrent(); if (await identity() !== userId) throw new Error('Сеанс изменился.'); assertCurrent(); };
    const input = args as Record<string, Json | undefined>;
    const target = ['p_task_item_id', 'p_item_id', 'p_task_id', 'p_template_id', 'p_project_id'].map((key) => input[key]).find((v) => typeof v === 'string') ?? 'self';
    const legacyKey = `sync:mutation:${name}:${target}`;
    const key = `sync:mutation:v3:${name}:${target}`;
    const read = () => boundedOperation(async (readSignal) => {
      const driver = localCacheDriver.withOperation?.(readSignal) ?? localCacheDriver;
      const entry = await driver.get(userId, key);
      if (entry) return entry;
      const legacy = await driver.get(userId, legacyKey);
      if (!legacy) return null;
      // One conditional transaction: no queue deletion, partial copy or handle
      // rewrite. Old online code cannot discover a v3 handle as a legacy UUID.
      const moved = { ...legacy, key };
      if (await driver.commitCacheBatch(userId, [moved], [legacyKey],
        [{ key, data: null }, { key: legacyKey, data: legacy.data }], readSignal)) return moved;
      return driver.get(userId, key);
    }, 5000, signal);
    const observed = pending(await read(), name);
    assertCurrent();
    const bindingKey = `${userId}:${key}`;
    const own = binding(bindingKey);
    const lockName = `tasktrace-mutation:${userId}`;
    // Only this tab's binding or an explicit retry identifies the old action.
    // A foreign persisted running/unknown envelope never identifies a fresh
    // form, regardless of equal arguments or an obsolete locks.query snapshot.
    const retry = options.mode === 'new' ? null : options.mode === 'retry' ? own ?? observed
      : own && !liveIntents.has(own.id) ? own : null;
    if (options.mode === 'retry' && !retry) throw reviewError('TT_OPERATION_HANDLE_MISSING');
    const intent = retry ?? { id: newAttemptId(), name, args: input, phase: 'running' as const, protocol_version: 3 as const };
    if (retry) binding(bindingKey, retry); // Capture durably BEFORE lock wait.
    liveIntents.add(intent.id);
    const work = async () => {
      await assertAccount();
      let entry = await read();
      assertCurrent();
      let saved = pending(entry, name);
      let operation = intent;
      let resolvesEarlier = false;
      if (!retry) {
        if (!saved) {
          const proposed: CacheEntry = { user_id: userId, key, data: JSON.stringify(intent), schema_version: 1, last_synced_at: new Date().toISOString() };
          const claimed = await boundedOperation((writeSignal) => localCacheDriver.commitCacheBatch(userId, [proposed], [], [{ key, data: null }], writeSignal), 5000, signal);
          assertCurrent();
          if (claimed) { entry = proposed; saved = intent; }
          else { entry = await read(); saved = pending(entry, name); assertCurrent(); }
        }
        // Never attribute a different, unresolved action's result to this
        // fresh intent. Reconcile it first and leave the new form intact.
        if (!saved) throw new Error('Состояние действия изменилось. Повторите действие.');
        operation = saved;
        resolvesEarlier = operation.id !== intent.id;
      }
      const replayingOther = resolvesEarlier || canonical(operation.args) !== canonical(input);
      let retire = entry && saved?.id === operation.id ? entry.data : null;
      await assertAccount();
      if (operation.phase === 'review') {
        // Another tab may acknowledge/remove the shared envelope while this
        // tab still retains its own review handle. Restore it for visible
        // reconciliation instead of trapping the form behind an invisible
        // session binding. A concurrent newer envelope must never be replaced.
        if (!saved) {
          const restored: CacheEntry = { user_id: userId, key, data: JSON.stringify(operation),
            schema_version: 1, last_synced_at: new Date().toISOString() };
          if (await boundedOperation(writeSignal => localCacheDriver.commitCacheBatch(userId,
            [restored], [], [{ key, data: null }], writeSignal), 5000, signal))
            announceReadModelCommit(userId, ['sync:mutation:review'], 'error');
        }
        throw reviewError(operation.review_reason ?? 'TT_OPERATION_EXPIRED');
      }
      if (operation.protocol_version === 3 && !operation.handle) {
        binding(bindingKey, operation);
        const context = await boundedOperation((requestSignal) => {
          const query = supabase.rpc('get_client_operation_context');
          return query.abortSignal?.(requestSignal) ?? query;
        }, 5000, signal).then(response => {
          if (response.error) throw response.error;
          return operationContext(response.data);
        }).catch(async error => {
          const paused: PendingMutation = { ...operation, phase: 'unknown' };
          if (readAccountEpoch() !== epoch || signal.aborted) throw error;
          await assertAccount(); binding(bindingKey, paused);
          if (retire !== null) await boundedOperation(writeSignal => localCacheDriver.commitCacheBatch(userId,
            [{ ...entry!, data: JSON.stringify(paused) }], [], [{ key, data: retire }], writeSignal), 5000, signal);
          announceReadModelCommit(userId, ['sync:mutation:review'], 'error');
          throw error;
        });
        await assertAccount();
        operation = { ...operation, handle: { ...context, id: operation.id } };
        if (retire !== null) {
          const bound = { ...entry!, data: JSON.stringify(operation) };
          if (!await boundedOperation((writeSignal) => localCacheDriver.commitCacheBatch(userId, [bound], [], [{ key, data: retire }], writeSignal), 5000, signal))
            throw new Error('Состояние действия изменилось. Повторите действие.');
          entry = bound; retire = bound.data;
        }
      }
      binding(bindingKey, operation); // Never send an operation without its retry handle.
      try {
        const result = await boundedOperation((requestSignal) => {
          const query = operation.handle
            ? supabase.rpc('execute_client_mutation_v3', { p_generation: operation.handle.generation, p_epoch: operation.handle.epoch,
              p_operation_id: operation.id, p_name: operation.name, p_args: operation.args as Json })
            : supabase.rpc('execute_client_mutation', { p_operation_id: operation.id, p_name: operation.name, p_args: operation.args as Json });
          return query.abortSignal?.(requestSignal) ?? query;
        }, 20_000, signal);
        if (result.error) Object.assign(result.error, { status: result.status });
        if (result.error && hasUnknownOutcome(result.error)) throw result.error;
        await assertAccount();
        const review = operationReview(result.error);
        if (review || ['TT_OPERATION_NOT_APPLIED', 'TT_OPERATION_WINDOW_CLOSING'].includes(result.error?.code ?? '')
          || ['TT_OPERATION_NOT_APPLIED', 'TT_OPERATION_WINDOW_CLOSING'].includes(result.error?.details ?? '')) {
          const reason = review ?? result.error!.code;
          const updated: PendingMutation = { ...operation, phase: 'review', review_reason: reason };
          binding(bindingKey, updated);
          if (retire !== null) await boundedOperation((writeSignal) => localCacheDriver.commitCacheBatch(userId,
            [{ ...entry!, data: JSON.stringify(updated) }], [], [{ key, data: retire }], writeSignal), 5000, signal);
          announceReadModelCommit(userId, ['sync:mutation:review'], 'error');
          throw reviewError(reason);
        }
        // A gateway/Auth rejection says nothing about an earlier committed
        // attempt. Keep its handle while returning the authoritative denial;
        // otherwise reauthentication could turn the next retry into a new ID.
        const code = result.error?.code ?? '';
        const lookupDenial = ['add_project_member_by_identifier', 'add_task_member_by_identifier'].includes(operation.name)
          && code === 'TT_MEMBER_LOOKUP' && result.status === 400;
        // Admission failures retain the pending intent. A manual retry after
        // capacity returns must use the same UUID, including across reloads.
        const admissionRejection = result.error && ['TT_RECEIPT_POLICY', 'TT_RECEIPT_LIMIT', 'TT_RECEIPT_RATE'].includes(result.error.details);
        const unconfirmedRejection = result.error && ((!/^[A-Z0-9]{5}$/.test(code) && !lookupDenial)
          || admissionRejection || ((retry || resolvesEarlier) && ['42501', '28000', '28P01'].includes(code)));
        if (unconfirmedRejection) {
          // The request has settled even though its historical outcome remains
          // unresolved. Persisting `running` here breaks recovery on runtimes
          // without Web Locks.query (including Node 22/native reloads).
          const paused: PendingMutation = { ...operation, phase: 'unknown' };
          binding(bindingKey, paused);
          if (retire !== null) await boundedOperation(writeSignal => localCacheDriver.commitCacheBatch(userId,
            [{ ...entry!, data: JSON.stringify(paused) }], [], [{ key, data: retire }], writeSignal), 5000, signal);
          announceReadModelCommit(userId, ['sync:mutation:review'], 'error');
          return result as MutationResult<Name>;
        }
        if (retire !== null) await boundedOperation((writeSignal) => localCacheDriver.commitCacheBatch(userId, [], [key], [{ key, data: retire }], writeSignal), 5000, signal);
        await assertAccount();
        if (binding(bindingKey)?.id === operation.id) binding(bindingKey, null);
        announceReadModelCommit(userId, ['sync:mutation:review'], 'read');
        // Replaying a definitive denial cannot close a fresh form as success.
        // Preserve its authoritative error for an unchanged manual submission;
        // a changed form still receives the explicit reconciliation notice.
        if (replayingOther && result.error && canonical(operation.args) === canonical(input)) return result as MutationResult<Name>;
        if (replayingOther) throw Object.assign(new Error(result.error
          ? 'Предыдущее действие не выполнено. Повторите новое действие.'
          : 'Предыдущее действие выполнено. Обновите данные перед новым действием.'), { code: 'TT_MUTATION_RECONCILED' });
        return result as MutationResult<Name>;
      } catch (error) {
        if (hasUnknownOutcome(error)) {
          // Other tabs can explicitly retry an unknown result. If cancellation
          // prevents this write, the tab handle still retains the exact ID.
          if (!signal.aborted && readAccountEpoch() === epoch && retire !== null) {
            const unknown: CacheEntry = { ...entry!, data: JSON.stringify({ ...operation, phase: 'unknown' }) };
            await boundedOperation((writeSignal) => localCacheDriver.commitCacheBatch(userId, [unknown], [], [{ key, data: retire }], writeSignal), 5000, signal)
              .then(committed => { if (committed) announceReadModelCommit(userId, ['sync:mutation:review'], 'error'); }).catch(() => undefined);
          }
          throw Object.assign(new Error('Ответ сервера не получен. Результат действия уточняется при повторе; повтор использует тот же идентификатор.'), { name: 'MutationOutcomeUnknownError', cause: error });
        }
        throw error;
      }
    };
    try {
      return await (typeof navigator !== 'undefined' && navigator.locks
        ? navigator.locks.request(lockName, { signal }, () => navigator.locks.request(`${lockName}:${intent.id}`, { signal }, work))
        : serial(userId, work));
    } finally { liveIntents.delete(intent.id); }
  }, 45_000);
}

/** Explicit review never resends a command. Guard is used by the later UI acknowledgement. */
export async function inspectOnlineMutation(userId: string, key: string) {
  const account = readAccountEpoch();
  return boundedOperation(async signal => {
    const current = async () => {
      if (signal.aborted || readAccountEpoch() !== account || await activeCacheUserId() !== userId) throw new Error('Сеанс изменился.');
    };
    await current();
    const entry = await localCacheDriver.get(userId, key);
    if (!entry || !key.startsWith('sync:mutation:')) throw new Error('Действие уже согласовано.');
    const saved = JSON.parse(entry.data) as PendingMutation;
    if (saved.phase !== 'review' && saved.phase !== 'unknown') throw new Error('Действие изменилось.');
    const h = saved.handle;
    const query = h ? supabase.rpc('resolve_client_operation_v3', { p_generation: h.generation, p_epoch: h.epoch,
      p_operation_id: saved.id, p_type: 'rpc:' + saved.name, p_target: saved.id, p_payload: saved.args as Json })
      : supabase.rpc('resolve_legacy_client_operation', { p_operation_id: saved.id, p_type: 'rpc:' + saved.name,
        p_target: saved.id, p_payload: saved.args as Json });
    const resolved = saved.protocol_version === 3 && !h
      ? { data: { state: 'never_sent' }, error: null }
      : await (query.abortSignal?.(signal) ?? query);
    if (resolved.error) throw resolved.error;
    const a = saved.args;
    // Read through the current account's RLS. This is a review of current
    // state, never evidence that a historical create was or was not applied.
    const fresh = a.p_task_item_id ? supabase.from('task_items').select('id,title,percentage,is_completed,comment,sync_version').eq('id',String(a.p_task_item_id))
      : a.p_task_id ? supabase.from('tasks').select('id,title,description,status').eq('id',String(a.p_task_id))
        : a.p_template_id ? supabase.rpc('get_task_template', { p_template_id: String(a.p_template_id) })
          : a.p_item_id ? supabase.rpc('list_task_templates')
            : a.p_project_id ? (saved.name === 'create_task' || saved.name === 'create_task_from_template'
              ? supabase.from('tasks').select('id,title,status').eq('project_id',String(a.p_project_id)).limit(50)
              : supabase.from('projects').select('id,name,description,status').eq('id',String(a.p_project_id)))
          : saved.name.includes('notification') ? supabase.from('notifications').select('id,title,is_read').limit(50)
            : saved.name.includes('profile') ? supabase.from('profiles').select('id,display_name').eq('id',userId)
              : saved.name.includes('template') ? supabase.rpc('list_task_templates')
              : supabase.from('projects').select('id,name,status').limit(50);
    const result = await fresh.abortSignal(signal);
    if (result.error) throw result.error;
    await current();
    const isRow = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
    const data: unknown = result.data;
    const rows = Array.isArray(data) ? data : isRow(data) ? [data, ...(Array.isArray(data.items) ? data.items : [])] : [];
    const currentRows = rows.filter(isRow).map((row, index) => ({
      id: typeof row.id === 'string' ? row.id : String(index),
      label: [row.title, row.name, row.display_name].find((value): value is string => typeof value === 'string') ?? 'Запись',
      detail: typeof row.percentage === 'number' ? `${row.percentage}%` : typeof row.is_read === 'boolean' ? (row.is_read ? 'прочитано' : 'не прочитано') : '',
    }));
    return { guard: entry.data, current: currentRows, resolution: resolved.data as OperationResolution };
  }, 20_000);
}

/** User acknowledges a fresh review; a subsequent form save is a NEW action. */
export async function acknowledgeOnlineReview(userId: string, key: string, guard: string, resolution: OperationResolution) {
  if (await activeCacheUserId() !== userId) throw new Error('Сеанс изменился.');
  const saved = JSON.parse(guard) as PendingMutation;
  if (!['review', 'unknown'].includes(saved.phase ?? '') || !['completed', 'result_redacted', 'expired', 'history_reset', 'not_applied', 'never_sent'].includes(resolution.state)) throw new Error('Исход ещё не определён. Проверьте его ещё раз.');
  if (!await localCacheDriver.commitCacheBatch(userId, [], [key], [{ key, data: guard }])) throw new Error('Действие изменилось. Проверьте его ещё раз.');
  const bindingKey = `${userId}:${key}`;
  if (binding(bindingKey)?.id === saved.id) binding(bindingKey, null);
  announceReadModelCommit(userId, ['sync:mutation:review'], 'read');
}

/** UI retry after read-only resolution: persist/capture the SAME full handle. */
export async function retryOnlineMutation(userId: string, key: string, guard: string, resolution: OperationResolution) {
  if (await activeCacheUserId() !== userId || resolution.state !== 'unknown') throw new Error('Исход изменился. Получите актуальное состояние.');
  const saved = pending({ data: guard } as CacheEntry, JSON.parse(guard).name);
  if (!saved?.handle) throw reviewError('TT_OPERATION_HANDLE_MISSING');
  const resumed: PendingMutation = { ...saved, phase: 'unknown', review_reason: undefined };
  const entry: CacheEntry = { user_id: userId, key, schema_version: 1, last_synced_at: new Date().toISOString(), data: JSON.stringify(resumed) };
  if (!await localCacheDriver.commitCacheBatch(userId, [entry], [], [{ key, data: guard }])) throw new Error('Действие изменилось. Проверьте его ещё раз.');
  binding(`${userId}:${key}`, resumed);
  // Persisted JSON crosses the typed RPC boundary only here; the server still
  // validates the allowlisted name, signature and immutable request fingerprint.
  const result = await executeMutation(saved.name as keyof Database['public']['Functions'],
    saved.args as MutationArgs<keyof Database['public']['Functions']>, { mode: 'retry' });
  if (result.error) throw result.error;
}
