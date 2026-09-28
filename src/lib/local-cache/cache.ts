import { supabase } from '@/lib/supabase/client';
import { ResourceAccessDeniedError } from '@/lib/errors/domain-errors';
import { localCacheDriver } from './driver';
import { LOCAL_CACHE_SCHEMA_VERSION, type CacheEntry } from './types';

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
    const { data, error } = await supabase.auth.getSession();
    const session = data.session;
    if (error || !session?.user?.id) return null;
    if (session.expires_at && session.expires_at * 1000 <= Date.now()) return null;
    return session.user.id;
  } catch {
    return null;
  }
}

export async function activeCacheUserId(): Promise<string | null> {
  return sessionUserId();
}

export async function getCached<T>(userId: string, key: string): Promise<T | null> {
  try {
    const entry = await localCacheDriver.get(userId, key);
    if (!entry || entry.user_id !== userId || entry.key !== key || entry.schema_version !== LOCAL_CACHE_SCHEMA_VERSION) return null;
    return markCached(JSON.parse(entry.data) as T);
  } catch (error) {
    logCacheError('read', error);
    return null;
  }
}

export async function putCached<T>(userId: string, key: string, value: T): Promise<void> {
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

async function removeCached(userId: string, key: string): Promise<void> {
  try {
    await localCacheDriver.remove(userId, key);
  } catch (error) {
    logCacheError('remove', error);
  }
}

export function isExplicitAccessError(error: unknown): boolean {
  if (error instanceof ResourceAccessDeniedError) return true;
  const value = error as { status?: number; code?: string; message?: string } | null;
  const message = value?.message?.toLowerCase() ?? '';
  return value?.status === 401 || value?.status === 403 || value?.code === '42501' || value?.code === 'PGRST301'
    || /invalid jwt|jwt expired|session expired|auth session missing/.test(message);
}

export function isTransportFailure(error: unknown): boolean {
  if (isExplicitAccessError(error)) return false;
  const value = error as { status?: number; code?: string; message?: string } | null;
  if (value?.code && value.code !== 'PGRST000') return false;
  if (value?.status === 502 || value?.status === 503 || value?.status === 504) return true;
  if (value?.status && value.status !== 0) return false;
  const message = value?.message?.toLowerCase() ?? '';
  return /failed to fetch|fetch failed|network request failed|networkerror|network error|err_network|load failed|timed? out|timeout/.test(message);
}

type ReadOptions<T> = {
  projectId?: string;
  clearProjectBlockOnSuccess?: boolean;
  taskId?: string;
  filterCached?: (userId: string, value: T) => Promise<T>;
};

export async function readThroughCache<T>(key: string, online: () => Promise<T>, options: ReadOptions<T> = {}): Promise<T> {
  const userId = await sessionUserId();
  try {
    const value = await online();
    if (userId && await sessionUserId() === userId) {
      await putCached(userId, key, value);
      if (options.projectId && options.clearProjectBlockOnSuccess) await removeCached(userId, `blocked:${options.projectId}`);
      if (options.taskId) await removeCached(userId, `blocked-task:${options.taskId}`);
    }
    return value;
  } catch (error) {
    if (userId && isExplicitAccessError(error) && await sessionUserId() === userId) {
      await removeCached(userId, key);
      if (options.projectId) await putCached(userId, `blocked:${options.projectId}`, true);
      if (options.taskId) await putCached(userId, `blocked-task:${options.taskId}`, true);
    }
    if (!userId || !isTransportFailure(error) || await sessionUserId() !== userId) throw error;
    if (options.projectId && await getCached<boolean>(userId, `blocked:${options.projectId}`)) throw error;
    if (options.taskId && await getCached<boolean>(userId, `blocked-task:${options.taskId}`)) throw error;
    const cached = await getCached<T>(userId, key);
    if (cached === null) throw error;
    return markCached(options.filterCached ? await options.filterCached(userId, cached) : cached);
  }
}

export async function filterBlockedProjects<T extends { id: string }>(userId: string, projects: T[]): Promise<T[]> {
  const blocked = await Promise.all(projects.map((project) => getCached<boolean>(userId, `blocked:${project.id}`)));
  return projects.filter((_, index) => !blocked[index]);
}

export async function reconcileVisibleProjects(userId: string, previous: { id: string }[], current: { id: string }[]): Promise<void> {
  const currentIds = new Set(current.map((project) => project.id));
  await Promise.all([
    ...current.map((project) => removeCached(userId, `blocked:${project.id}`)),
    ...previous.filter((project) => !currentIds.has(project.id)).map((project) => putCached(userId, `blocked:${project.id}`, true)),
  ]);
}

export async function filterBlockedTasks<T extends { id: string }>(userId: string, tasks: T[]): Promise<T[]> {
  const blocked = await Promise.all(tasks.map((task) => getCached<boolean>(userId, `blocked-task:${task.id}`)));
  return tasks.filter((_, index) => !blocked[index]);
}

export async function reconcileVisibleTasks(userId: string, previous: { id: string }[], current: { id: string }[]): Promise<void> {
  const currentIds = new Set(current.map((task) => task.id));
  await Promise.all([
    ...current.map((task) => removeCached(userId, `blocked-task:${task.id}`)),
    ...previous.filter((task) => !currentIds.has(task.id)).map((task) => putCached(userId, `blocked-task:${task.id}`, true)),
  ]);
}
