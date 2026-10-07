import { getReadSession } from '@/lib/supabase/session';
import { usesLocalReads, reportConnectivityFailure, reportConnectivitySuccess, connectivityRequestEpoch } from '@/lib/connectivity/state';
import { ConnectivityUnavailableError, isExplicitAccessError, isTransportFailure } from '@/lib/connectivity/errors';
import { localCacheDriver } from './driver';
import { LOCAL_CACHE_SCHEMA_VERSION, type CacheEntry } from './types';
import { cacheAccessDecision, cacheAccessEpoch, confirmCacheAccess, deniedSince, denyCacheAccess } from './access-state';
import { ResourceAccessDeniedError } from '@/lib/errors/domain-errors';
import { announceReadModelCommit, overviewReadModelChanged } from './read-model-events';
import { confirmReadFreshness, durableReadInvalidation, freshnessKey, invalidateReadModels, isReadModelKey, readAccountEpoch, READ_FRESHNESS_MS, readInvalidation, settleReadInvalidations } from './read-freshness';
import type { TaskItem } from '@/lib/supabase/client';
export { isExplicitAccessError, isTransportFailure } from '@/lib/connectivity/errors';

const cachedResults = new WeakSet<object>();
const supersededResults = new WeakSet<object>();
const localResults = new WeakSet<object>();
const refreshes = new Map<string, { version: number; promise: Promise<unknown> }>();
const failedRefreshes = new Set<string>();
// A lifecycle fence is not a new server denial. In particular an old response
// must never persist a block after a newer ACL check has already succeeded.
class SupersededReadError extends ResourceAccessDeniedError {}
export function isLocalResult(value: unknown): boolean {
  return value !== null && typeof value === 'object' && localResults.has(value);
}
export function isSupersededResult(value: unknown): boolean {
  return value !== null && typeof value === 'object' && supersededResults.has(value);
}

export function isCachedResult(value: unknown): boolean {
  return value !== null && typeof value === 'object' && cachedResults.has(value);
}

function markCached<T>(value: T): T {
  if (value !== null && typeof value === 'object') { cachedResults.add(value); localResults.add(value); }
  return value;
}

export function inheritCachedResult<T>(source: unknown, value: T): T {
  if (isLocalResult(source) && value !== null && typeof value === 'object') localResults.add(value);
  return isCachedResult(source) ? markCached(value) : value;
}

function logCacheError(operation: string, error: unknown): void {
  console.warn(`[TaskTrace] local cache ${operation} failed`, error);
}

async function sessionUserId(): Promise<string | null> {
  try {
    const { data, error } = await getReadSession();
    const session = data.session;
    if (error || !session?.user?.id) return null;
    if (!usesLocalReads() && session.expires_at && session.expires_at * 1000 <= Date.now()) return null;
    return session.user.id;
  } catch {
    return null;
  }
}

export async function activeCacheUserId(): Promise<string | null> {
  return sessionUserId();
}

export async function getCached<T>(userId: string, key: string): Promise<T | null> {
  if (key.startsWith('blocked:') || key.startsWith('blocked-task:')) {
    const decision = cacheAccessDecision(userId, key);
    if (decision !== undefined) return decision as T;
  } else if (cacheAccessDecision(userId, `cache:${key}`)) return null;
  try {
    if (isReadModelKey(key) && (readInvalidation(userId, key).kind === 'access' || (await durableReadInvalidation(userId, key)).kind === 'access')) return null;
    const entry = await localCacheDriver.get(userId, key);
    if (isReadModelKey(key) && (readInvalidation(userId, key).kind === 'access' || (await durableReadInvalidation(userId, key)).kind === 'access')) return null;
    // A denial can arrive while IndexedDB is completing this read.
    if (key.startsWith('blocked:') || key.startsWith('blocked-task:')) {
      const decision = cacheAccessDecision(userId, key);
      if (decision !== undefined) return decision as T;
    } else if (cacheAccessDecision(userId, `cache:${key}`)) return null;
    if (!entry && /^items:.*:all$/.test(key)) {
      const prefix = key.slice(0, -3);
      const [active, archived] = await Promise.all([getCached<TaskItem[]>(userId, `${prefix}active`), getCached<TaskItem[]>(userId, `${prefix}archived`)]);
      if (!active || !archived) return null;
      const items = new Map<string, TaskItem>();
      for (const item of [...active, ...archived]) if (!items.has(item.id) || (item.sync_version ?? 0) >= (items.get(item.id)!.sync_version ?? 0)) items.set(item.id, item);
      return markCached([...items.values()].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)) as T);
    }
    if (!entry || entry.user_id !== userId || entry.key !== key || entry.schema_version !== LOCAL_CACHE_SCHEMA_VERSION) return null;
    return markCached(JSON.parse(entry.data) as T);
  } catch (error) {
    logCacheError('read', error);
    return null;
  }
}

export async function putCached<T>(userId: string, key: string, value: T): Promise<void> {
  if ((key.startsWith('blocked:') || key.startsWith('blocked-task:')) && value === true) denyCacheAccess(userId, key);
  try {
    const entry: CacheEntry = {
      user_id: userId,
      key,
      data: JSON.stringify(value),
      last_synced_at: new Date().toISOString(),
      schema_version: LOCAL_CACHE_SCHEMA_VERSION,
    };
    await localCacheDriver.put(entry);
  } catch (error) {
    logCacheError('write', error);
  }
}

async function putCachedIfUnchanged<T>(userId: string, key: string, value: T, expectedData: string | null, staleData?: string | null,
  partitionGuards?: { key: string; data: string | null }[]): Promise<{ committed: boolean; newer?: T }> {
  try {
    const data = JSON.stringify(value);
    const entry = {
      user_id: userId, key, data,
      last_synced_at: new Date().toISOString(), schema_version: LOCAL_CACHE_SCHEMA_VERSION,
    };
    const prefix = key.slice(0, -3);
    const partitions = partitionGuards ? ['active', 'archived'].map((mode) => ({ ...entry, key: `${prefix}${mode}`,
      data: JSON.stringify((value as TaskItem[]).filter((item) => item.is_archived === (mode === 'archived'))) })) : [entry];
    const committed = staleData === undefined ? await localCacheDriver.putIfUnchanged(entry, expectedData)
      : await localCacheDriver.commitCacheBatch(userId, partitions, [freshnessKey(key), ...(partitionGuards ? [key, freshnessKey(`${prefix}active`), freshnessKey(`${prefix}archived`)] : [])],
        [{ key, data: expectedData }, { key: freshnessKey(key), data: staleData }, ...(partitionGuards ?? [])]);
    let current = await localCacheDriver.get(userId, key);
    if (partitionGuards && !current) {
      const projected = committed !== false ? value : await getCached<T>(userId, key);
      if (projected) current = { ...entry, data: JSON.stringify(projected) };
    }
    if (committed === false || current?.data !== data)
      return { committed: false, newer: current?.user_id === userId && current.schema_version === LOCAL_CACHE_SCHEMA_VERSION ? JSON.parse(current.data) as T : undefined };
    if (current?.data === data && (/^(projects:|my-tasks:)/.test(key) ? overviewReadModelChanged(expectedData, data) : expectedData !== data))
      announceReadModelCommit(userId, partitionGuards ? [key, ...partitions.map((e) => e.key)] : [key], 'read');
    return { committed: true };
  } catch (error) {
    logCacheError('conditional write', error);
  }
  return { committed: false };
}

async function removeCached(userId: string, key: string): Promise<void> {
  try {
    await localCacheDriver.remove(userId, key);
  } catch (error) {
    logCacheError('remove', error);
  }
}

export type ReadOptions<T> = {
  cacheFirst?: boolean;
  forceRefresh?: boolean;
  onServerCommit?: (value: T, userId: string, accessBaseline: number) => Promise<void>;
  projectId?: string;
  clearProjectBlockOnSuccess?: boolean;
  taskId?: string;
  clearTaskBlockOnSuccess?: boolean;
  blockResourceOnAccessError?: boolean;
  filterCached?: (userId: string, value: T) => Promise<T>;
  cacheValue?: (value: T) => T;
};

export async function readThroughCache<T>(key: string, online: () => Promise<T>, options: ReadOptions<T> = {}): Promise<T> {
  const userId = await sessionUserId();
  const accountBaseline = readAccountEpoch();
  if (userId && options.cacheFirst && !usesLocalReads()) await settleReadInvalidations(userId);
  const accessBaseline = cacheAccessEpoch();
  const accessKeys = [`cache:${key}`, ...(options.projectId ? [`blocked:${options.projectId}`] : []), ...(options.taskId ? [`blocked-task:${options.taskId}`] : [])];
  const invalidation = userId ? readInvalidation(userId, key) : { version: 0, kind: null };
  const durable = userId && options.cacheFirst ? await durableReadInvalidation(userId, key) : { entry: null, kind: null };
  const accessCheck = invalidation.kind === 'access' || durable.kind === 'access';
  const local = async (error: unknown): Promise<T> => {
    let parentProjectId: string | undefined;
    if (!userId || await sessionUserId() !== userId || readAccountEpoch() !== accountBaseline) throw error;
    if (accessCheck || readInvalidation(userId, key).kind === 'access') throw new ResourceAccessDeniedError('Подтверждаем актуальный доступ к данным.');
    if (options.projectId && await getCached<boolean>(userId, `blocked:${options.projectId}`)) throw error;
    if (options.taskId && await getCached<boolean>(userId, `blocked-task:${options.taskId}`)) throw error;
    if (options.taskId) {
      const task = await getCached<{ project_id: string }>(userId, `task:${options.taskId}`);
      parentProjectId = task?.project_id;
      if (task && await getCached<boolean>(userId, `blocked:${task.project_id}`)) throw error;
    }
    const cached = await getCached<T>(userId, key);
    if (cached === null) throw error;
    const value = options.filterCached ? await options.filterCached(userId, cached) : cached;
    if (await sessionUserId() !== userId || readAccountEpoch() !== accountBaseline) throw error;
    if (readInvalidation(userId, key).kind === 'access' || (options.cacheFirst && (await durableReadInvalidation(userId, key)).kind === 'access')) throw new SupersededReadError('Доступ изменился во время загрузки.');
    if (accessKeys.some((accessKey) => cacheAccessDecision(userId, accessKey))
      || (parentProjectId && cacheAccessDecision(userId, `blocked:${parentProjectId}`))) throw error;
    return markCached(value);
  };
  if (usesLocalReads()) return local(new ConnectivityUnavailableError());
  let baseline: string | null | undefined;
  let partitionGuards: { key: string; data: string | null }[] | undefined;
  if (userId) {
    try { baseline = (await localCacheDriver.get(userId, key))?.data ?? null; }
    catch { baseline = undefined; }
    if (options.cacheFirst && /^items:.*:all$/.test(key)) {
      const prefix = key.slice(0, -3);
      const keys = [`${prefix}active`, `${prefix}archived`, freshnessKey(`${prefix}active`), freshnessKey(`${prefix}archived`)];
      partitionGuards = await Promise.all(keys.map(async (key) => ({ key, data: (await localCacheDriver.get(userId, key))?.data ?? null })));
    }
  }
  const refresh = async (): Promise<T> => { try {
    const epoch = connectivityRequestEpoch();
    const value = await online();
    reportConnectivitySuccess(epoch);
    if (userId && (await sessionUserId() !== userId || readAccountEpoch() !== accountBaseline)) throw new SupersededReadError('Сеанс изменился во время загрузки.');
    if (userId && readInvalidation(userId, key).version > invalidation.version) {
      if (readInvalidation(userId, key).kind === 'access') throw new SupersededReadError('Доступ изменился во время загрузки.');
      const latest = await local(new ConnectivityUnavailableError());
      if (latest !== null && typeof latest === 'object') { supersededResults.add(latest); cachedResults.delete(latest); }
      return latest;
    }
    if (userId) {
      if (accessKeys.some((accessKey) => deniedSince(userId, accessKey, accessBaseline)))
        throw new SupersededReadError('Доступ был отозван во время загрузки.');
      const replacement = baseline !== undefined ? await putCachedIfUnchanged(userId, key, options.cacheValue ? options.cacheValue(value) : value, baseline, options.cacheFirst ? durable.entry?.data ?? null : undefined, partitionGuards) : { committed: false };
      if (await sessionUserId() !== userId || readAccountEpoch() !== accountBaseline || readInvalidation(userId, key).version > invalidation.version
        || accessKeys.some((accessKey) => deniedSince(userId, accessKey, accessBaseline))) throw new SupersededReadError('Данные изменились во время загрузки.');
      confirmCacheAccess(userId, `cache:${key}`, accessBaseline);
      if (options.projectId && options.clearProjectBlockOnSuccess && confirmCacheAccess(userId, `blocked:${options.projectId}`, accessBaseline)) await removeCached(userId, `blocked:${options.projectId}`);
      if (options.taskId && options.clearTaskBlockOnSuccess && confirmCacheAccess(userId, `blocked-task:${options.taskId}`, accessBaseline)) await removeCached(userId, `blocked-task:${options.taskId}`);
      if (accessKeys.some((accessKey) => deniedSince(userId, accessKey, accessBaseline))) throw new SupersededReadError('Доступ был отозван во время загрузки.');
      if (!replacement.committed && replacement.newer !== undefined) {
        if (options.cacheFirst && (await durableReadInvalidation(userId, key)).kind === 'access') throw new SupersededReadError('Доступ изменился во время загрузки.');
        const latest = options.filterCached ? await options.filterCached(userId, replacement.newer) : replacement.newer;
        if (await sessionUserId() !== userId || readAccountEpoch() !== accountBaseline) throw new SupersededReadError('Сеанс изменился во время загрузки.');
        if (accessKeys.some((accessKey) => deniedSince(userId, accessKey, accessBaseline))) throw new SupersededReadError('Доступ был отозван во время загрузки.');
        if (latest !== null && typeof latest === 'object') supersededResults.add(latest);
        return latest;
      }
      if (replacement.committed) {
        confirmReadFreshness(userId, key, invalidation.version);
        if (partitionGuards) for (const mode of ['active', 'archived']) confirmReadFreshness(userId, `${key.slice(0, -3)}${mode}`, readInvalidation(userId, `${key.slice(0, -3)}${mode}`).version);
        failedRefreshes.delete(`${userId}:${key}`);
        if (options.onServerCommit) await options.onServerCommit(value, userId, accessBaseline);
      } else if (options.cacheFirst && (await durableReadInvalidation(userId, key)).kind === 'access') throw new SupersededReadError('Доступ изменился во время загрузки.');
    }
    return value;
  } catch (error) {
    if (error instanceof SupersededReadError) throw error;
    if (userId && (readAccountEpoch() !== accountBaseline || await sessionUserId() !== userId
      || readInvalidation(userId, key).version > invalidation.version)) throw new SupersededReadError('Сеанс или доступ изменился во время загрузки.');
    reportConnectivityFailure(error);
    if (userId && isExplicitAccessError(error) && await sessionUserId() === userId) {
      // Mark denial before the first await touching fallible persistent storage.
      if ((!options.projectId && !options.taskId) || options.blockResourceOnAccessError === false) denyCacheAccess(userId, `cache:${key}`);
      if (options.projectId && options.blockResourceOnAccessError !== false) denyCacheAccess(userId, `blocked:${options.projectId}`);
      if (options.taskId && options.blockResourceOnAccessError !== false) denyCacheAccess(userId, `blocked-task:${options.taskId}`);
      await removeCached(userId, key);
      if (options.projectId && options.blockResourceOnAccessError !== false) await putCached(userId, `blocked:${options.projectId}`, true);
      if (options.taskId && options.blockResourceOnAccessError !== false) await putCached(userId, `blocked-task:${options.taskId}`, true);
      if (!failedRefreshes.has(`${userId}:${key}`)) { failedRefreshes.add(`${userId}:${key}`); announceReadModelCommit(userId, [key], 'error'); }
    }
    if (!isTransportFailure(error)) {
      if (options.cacheFirst && userId && !isExplicitAccessError(error) && await sessionUserId() === userId) {
        if (invalidation.kind !== 'refresh' && durable.kind !== 'refresh') await invalidateReadModels(userId, [key], 'refresh').catch((error) => logCacheError('invalidation', error));
        if (!failedRefreshes.has(`${userId}:${key}`)) { failedRefreshes.add(`${userId}:${key}`); announceReadModelCommit(userId, [key], 'error'); }
      }
      throw error;
    }
    return local(error);
  } };
  const singleFlight = (): Promise<T> => {
    if (!options.cacheFirst) return refresh();
    const id = `${userId}:${key}:${accountBaseline}`;
    const existing = refreshes.get(id);
    if (existing?.version === invalidation.version) return (existing.promise as Promise<T>).then(async (value) => {
      if (await sessionUserId() !== userId || readAccountEpoch() !== accountBaseline || (userId && accessKeys.some((accessKey) => deniedSince(userId, accessKey, accessBaseline)))) throw new SupersededReadError('Сеанс или доступ изменился во время загрузки.');
      return options.filterCached && userId ? options.filterCached(userId, value) : value;
    });
    const promise = refresh().finally(() => { if (refreshes.get(id)?.promise === promise) refreshes.delete(id); });
    refreshes.set(id, { version: invalidation.version, promise }); return promise;
  };
  if (userId && options.cacheFirst && !options.forceRefresh && !accessCheck && invalidation.kind !== 'refresh' && durable.kind !== 'refresh') {
    let value: T | undefined;
    try { value = await local(new ConnectivityUnavailableError()); } catch { /* Missing/blocked cache requires the server. */ }
    if (value !== undefined) {
      let syncedAt = 0;
      const entry = await localCacheDriver.get(userId, key);
      if (entry) syncedAt = Date.parse(entry.last_synced_at);
      else if (/^items:.*:all$/.test(key)) {
        const prefix = key.slice(0, -3);
        const partitions = await Promise.all(['active', 'archived'].map((mode) => localCacheDriver.get(userId, `${prefix}${mode}`)));
        syncedAt = Math.min(...partitions.map((entry) => Date.parse(entry?.last_synced_at ?? '')));
      }
      const pendingAccess = await durableReadInvalidation(userId, key);
      if (await sessionUserId() !== userId || readAccountEpoch() !== accountBaseline || readInvalidation(userId, key).kind === 'access'
        || pendingAccess.kind === 'access' || accessKeys.some((accessKey) => cacheAccessDecision(userId, accessKey)))
        throw new SupersededReadError('Сеанс или доступ изменился во время загрузки.');
      if (invalidation.kind || durable.kind || !Number.isFinite(syncedAt) || Date.now() < syncedAt || Date.now() - syncedAt >= READ_FRESHNESS_MS) void singleFlight().catch(() => undefined);
      // A local online result is not an offline-mode signal. Keep its local
      // provenance separately for reconciliation; transport fallback stays marked.
      if (value !== null && typeof value === 'object') cachedResults.delete(value);
      return value;
    }
  }
  return singleFlight();
}

export function readCachedModel<T>(key: string, online: () => Promise<T>, options: ReadOptions<T> = {}): Promise<T> {
  return readThroughCache(key, online, { ...options, cacheFirst: true });
}

export async function filterBlockedProjects<T extends { id: string }>(userId: string, projects: T[]): Promise<T[]> {
  const blocked = await Promise.all(projects.map((project) => getCached<boolean>(userId, `blocked:${project.id}`)));
  return projects.filter((_, index) => !blocked[index]);
}

export async function reconcileVisibleProjects(userId: string, previous: { id: string }[], current: { id: string }[], accessBaseline = cacheAccessEpoch()): Promise<void> {
  const currentIds = new Set(current.map((project) => project.id));
  await Promise.all([
    ...current.map((project) => confirmCacheAccess(userId, `blocked:${project.id}`, accessBaseline) ? removeCached(userId, `blocked:${project.id}`) : Promise.resolve()),
    ...previous.filter((project) => !currentIds.has(project.id)).map((project) => putCached(userId, `blocked:${project.id}`, true)),
  ]);
}

export async function filterBlockedTasks<T extends { id: string }>(userId: string, tasks: T[]): Promise<T[]> {
  const blocked = await Promise.all(tasks.map((task) => getCached<boolean>(userId, `blocked-task:${task.id}`)));
  return tasks.filter((_, index) => !blocked[index]);
}

export async function reconcileVisibleTasks(userId: string, previous: { id: string }[], current: { id: string }[], accessBaseline = cacheAccessEpoch()): Promise<void> {
  const currentIds = new Set(current.map((task) => task.id));
  await Promise.all([
    ...current.map((task) => confirmCacheAccess(userId, `blocked-task:${task.id}`, accessBaseline) ? removeCached(userId, `blocked-task:${task.id}`) : Promise.resolve()),
    ...previous.filter((task) => !currentIds.has(task.id)).map((task) => putCached(userId, `blocked-task:${task.id}`, true)),
  ]);
}
