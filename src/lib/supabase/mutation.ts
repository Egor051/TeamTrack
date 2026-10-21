import { supabase, type Database } from './client';
import { activeCacheUserId, isTransportFailure } from '@/lib/local-cache/cache';
import { localCacheDriver } from '@/lib/local-cache/driver';
import { newOperationId } from '@/lib/local-cache/uuid';
import { boundedOperation } from '@/lib/connectivity/deadline';
import { readAccountEpoch } from '@/lib/local-cache/read-freshness';
import { usesLocalReads } from '@/lib/connectivity/state';
import { ConnectivityUnavailableError } from '@/lib/connectivity/errors';
import type { CacheEntry } from '@/lib/local-cache/types';
import type { Json } from '@/types/database.types';

type PendingMutation = { id: string; name: string; args: Record<string, Json | undefined>; phase?: 'running' | 'unknown' };
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
    const data = tabStorage ? tabStorage.getItem(storageKey) : volatileBindings.get(storageKey);
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
export function executeMutation<Name extends keyof Database['public']['Functions']>(name: Name, args: MutationArgs<Name>): Promise<MutationResult<Name>> {
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
    const key = `sync:mutation:${name}:${target}`;
    const read = () => boundedOperation((readSignal) => (localCacheDriver.withOperation?.(readSignal) ?? localCacheDriver).get(userId, key), 5000, signal);
    const observed = pending(await read(), name);
    assertCurrent();
    const bindingKey = `${userId}:${key}`;
    const own = binding(bindingKey);
    const lockName = `tasktrace-mutation:${userId}`;
    // Without a cross-context liveness API, do not silently merge a second
    // fresh action into an apparently running one. Reconcile ambiguity under
    // the cache guard instead. An own orphaned handle still identifies retry.
    let inFlight = observed?.phase === 'running';
    if (observed?.phase === 'running' && typeof navigator !== 'undefined' && navigator.locks?.query) {
      const locks = await boundedOperation(() => navigator.locks.query(), 5000, signal);
      assertCurrent();
      inFlight = locks.held?.some((lock) => lock.name === lockName) ?? false;
    }
    // An orphaned tab handle means reload/timeout. A live, running request is
    // a separate intent from a second invocation, even with identical fields.
    // Persisted `running` alone is not proof of live work after abrupt closure.
    const retry = own && !liveIntents.has(own.id) ? own
      : observed && (observed.phase !== 'running' || !inFlight) ? observed : null;
    const intent = retry ?? { id: newOperationId(), name, args: input, phase: 'running' as const };
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
      const retire = entry && saved?.id === operation.id ? entry.data : null;
      await assertAccount();
      binding(bindingKey, operation); // Never send an operation without its retry handle.
      try {
        const result = await boundedOperation((requestSignal) => {
          const query = supabase.rpc('execute_client_mutation', { p_operation_id: operation.id, p_name: operation.name, p_args: operation.args as Json });
          return query.abortSignal?.(requestSignal) ?? query;
        }, 20_000, signal);
        if (result.error) Object.assign(result.error, { status: result.status });
        if (result.error && hasUnknownOutcome(result.error)) throw result.error;
        await assertAccount();
        // A gateway/Auth rejection says nothing about an earlier committed
        // attempt. Keep its handle while returning the authoritative denial;
        // otherwise reauthentication could turn the next retry into a new ID.
        const code = result.error?.code ?? '';
        const unconfirmedRejection = result.error && (!/^[A-Z0-9]{5}$/.test(code)
          || ((retry || resolvesEarlier) && ['42501', '28000', '28P01'].includes(code)));
        if (unconfirmedRejection) return result as MutationResult<Name>;
        if (retire !== null) await boundedOperation((writeSignal) => localCacheDriver.commitCacheBatch(userId, [], [key], [{ key, data: retire }], writeSignal), 5000, signal);
        await assertAccount();
        if (binding(bindingKey)?.id === operation.id) binding(bindingKey, null);
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
            await boundedOperation((writeSignal) => localCacheDriver.commitCacheBatch(userId, [unknown], [], [{ key, data: retire }], writeSignal), 5000, signal).catch(() => undefined);
          }
          throw Object.assign(new Error('Ответ сервера не получен. Результат действия уточняется при повторе; повтор использует тот же идентификатор.'), { name: 'MutationOutcomeUnknownError', cause: error });
        }
        throw error;
      }
    };
    try {
      return await (typeof navigator !== 'undefined' && navigator.locks
        ? navigator.locks.request(lockName, { signal }, work)
        : serial(userId, work));
    } finally { liveIntents.delete(intent.id); }
  }, 45_000);
}
