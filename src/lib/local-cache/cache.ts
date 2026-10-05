import { getReadSession } from '@/lib/supabase/session';
import { usesLocalReads, reportConnectivityFailure, reportConnectivitySuccess, connectivityRequestEpoch } from '@/lib/connectivity/state';
import { ConnectivityUnavailableError, isExplicitAccessError, isTransportFailure } from '@/lib/connectivity/errors';
import { localCacheDriver } from './driver';
import { LOCAL_CACHE_SCHEMA_VERSION, type CacheEntry } from './types';
import { cacheAccessDecision, cacheAccessEpoch, confirmCacheAccess, deniedSince, denyCacheAccess } from './access-state';
import { ResourceAccessDeniedError } from '@/lib/errors/domain-errors';
export { isExplicitAccessError, isTransportFailure } from '@/lib/connectivity/errors';

const cachedResults = new WeakSet<object>();

export function isCachedResult(value: unknown): boolean {
  return value !== null && typeof value === 'object' && cachedResults.has(value);
}

function markCached<T>(value: T): T {
  if (value !== null && typeof value === 'object') cachedResults.add(value);
  return value;
}

export function inheritCachedResult<T>(source: unknown, value: T): T {
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
    const entry = await localCacheDriver.get(userId, key);
    // A denial can arrive while IndexedDB is completing this read.
    if (key.startsWith('blocked:') || key.startsWith('blocked-task:')) {
      const decision = cacheAccessDecision(userId, key);
      if (decision !== undefined) return decision as T;
    } else if (cacheAccessDecision(userId, `cache:${key}`)) return null;
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

async function putCachedIfUnchanged<T>(userId: string, key: string, value: T, expectedData: string | null): Promise<void> {
  try {
    await localCacheDriver.putIfUnchanged({
      user_id: userId, key, data: JSON.stringify(value),
      last_synced_at: new Date().toISOString(), schema_version: LOCAL_CACHE_SCHEMA_VERSION,
    }, expectedData);
  } catch (error) {
    logCacheError('conditional write', error);
  }
}

async function removeCached(userId: string, key: string): Promise<void> {
  try {
    await localCacheDriver.remove(userId, key);
  } catch (error) {
    logCacheError('remove', error);
  }
}

type ReadOptions<T> = {
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
  const accessBaseline = cacheAccessEpoch();
  const accessKeys = [`cache:${key}`, ...(options.projectId ? [`blocked:${options.projectId}`] : []), ...(options.taskId ? [`blocked-task:${options.taskId}`] : [])];
  const local = async (error: unknown): Promise<T> => {
    let parentProjectId: string | undefined;
    if (!userId || await sessionUserId() !== userId) throw error;
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
    if (await sessionUserId() !== userId) throw error;
    if (accessKeys.some((accessKey) => cacheAccessDecision(userId, accessKey))
      || (parentProjectId && cacheAccessDecision(userId, `blocked:${parentProjectId}`))) throw error;
    return markCached(value);
  };
  if (usesLocalReads()) return local(new ConnectivityUnavailableError());
  let baseline: string | null | undefined;
  if (userId) {
    try { baseline = (await localCacheDriver.get(userId, key))?.data ?? null; }
    catch { baseline = undefined; }
  }
  try {
    const epoch = connectivityRequestEpoch();
    const value = await online();
    reportConnectivitySuccess(epoch);
    if (userId && await sessionUserId() === userId) {
      if (accessKeys.some((accessKey) => deniedSince(userId, accessKey, accessBaseline)))
        throw new ResourceAccessDeniedError('Доступ был отозван во время загрузки.');
      if (baseline !== undefined) await putCachedIfUnchanged(userId, key, options.cacheValue ? options.cacheValue(value) : value, baseline);
      confirmCacheAccess(userId, `cache:${key}`, accessBaseline);
      if (options.projectId && options.clearProjectBlockOnSuccess && confirmCacheAccess(userId, `blocked:${options.projectId}`, accessBaseline)) await removeCached(userId, `blocked:${options.projectId}`);
      if (options.taskId && options.clearTaskBlockOnSuccess && confirmCacheAccess(userId, `blocked-task:${options.taskId}`, accessBaseline)) await removeCached(userId, `blocked-task:${options.taskId}`);
      if (accessKeys.some((accessKey) => deniedSince(userId, accessKey, accessBaseline))) throw new ResourceAccessDeniedError('Доступ был отозван во время загрузки.');
    }
    return value;
  } catch (error) {
    reportConnectivityFailure(error);
    if (userId && isExplicitAccessError(error) && await sessionUserId() === userId) {
      // Mark denial before the first await touching fallible persistent storage.
      if ((!options.projectId && !options.taskId) || options.blockResourceOnAccessError === false) denyCacheAccess(userId, `cache:${key}`);
      if (options.projectId && options.blockResourceOnAccessError !== false) denyCacheAccess(userId, `blocked:${options.projectId}`);
      if (options.taskId && options.blockResourceOnAccessError !== false) denyCacheAccess(userId, `blocked-task:${options.taskId}`);
      await removeCached(userId, key);
      if (options.projectId && options.blockResourceOnAccessError !== false) await putCached(userId, `blocked:${options.projectId}`, true);
      if (options.taskId && options.blockResourceOnAccessError !== false) await putCached(userId, `blocked-task:${options.taskId}`, true);
    }
    if (!isTransportFailure(error)) throw error;
    return local(error);
  }
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
