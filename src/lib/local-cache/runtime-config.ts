import { supabase } from '@/lib/supabase/client';
import { activeCacheUserId, getCached, isTransportFailure } from './cache';
import { localCacheDriver } from './driver';
import { notifySyncState } from './status';
import { LOCAL_CACHE_SCHEMA_VERSION, type CacheEntry } from './types';
import { usesLocalReads } from '@/lib/connectivity/state';
import { getReadSession } from '@/lib/supabase/session';

// TTL schedules online refresh; it never expires an offline confirmation.
export const RUNTIME_CONFIG_TTL_MS = 60_000;
export const RUNTIME_CONFIG_KEY = 'runtime:offline-capabilities';
type RemoteConfig = { write_enabled: boolean; sync_enabled: boolean; protocol_version: number; updated_at: string };
type Snapshot = { user_id: string; value: RemoteConfig | null; fetched_at: number };
type Capabilities = { write: boolean; sync: boolean; available: boolean };
type RefreshResult = { capabilities: Capabilities; confirmed: boolean };
const unavailable: Capabilities = { write: false, sync: false, available: false };
const refreshed = new Set<string>();
const blocked = new Set<string>();
const inFlight = new Map<string, Promise<RefreshResult>>();
let generation = 0;

export function buildWriteEnabled(): boolean { return process.env.EXPO_PUBLIC_OFFLINE_WRITE_ENABLED === 'true'; }
export function buildSyncEnabled(): boolean { return process.env.EXPO_PUBLIC_OFFLINE_SYNC_ENABLED === 'true'; }

export function clearRuntimeConfig(userId?: string): void {
  // Invalidate pending responses during logout/account changes. Durable cache
  // remains user-scoped, following the existing offline-cache retention policy.
  generation += 1;
  if (userId) { refreshed.delete(userId); blocked.delete(userId); inFlight.delete(userId); }
  else { refreshed.clear(); blocked.clear(); inFlight.clear(); }
}

function validate(value: unknown): RemoteConfig {
  const row = value as Partial<RemoteConfig> | null;
  if (!row || typeof row.write_enabled !== 'boolean' || typeof row.sync_enabled !== 'boolean'
    || row.protocol_version !== 2 || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at)))
    throw new Error('Некорректная конфигурация синхронизации.');
  return { write_enabled: row.write_enabled, sync_enabled: row.sync_enabled,
    protocol_version: row.protocol_version, updated_at: row.updated_at };
}

function snapshot(value: unknown, userId: string): Snapshot | null {
  const row = value as Partial<Snapshot> | null;
  if (!row || row.user_id !== userId || typeof row.fetched_at !== 'number'
    || !Number.isFinite(row.fetched_at) || row.fetched_at <= 0) return null;
  try { return { user_id: userId, fetched_at: row.fetched_at, value: row.value === null ? null : validate(row.value) }; }
  catch { return null; }
}

function effective(current: Snapshot | null): Capabilities {
  if (!current?.value) return unavailable;
  const sync = buildSyncEnabled() && current.value.sync_enabled;
  return { write: buildWriteEnabled() && sync && current.value.write_enabled, sync, available: true };
}

function compareRevision(a: string, b: string): number {
  const milliseconds = Date.parse(a) - Date.parse(b);
  if (milliseconds) return milliseconds;
  // PostgreSQL updated_at has microseconds. Date.parse alone would make a
  // newer denial and an older allow within one millisecond look identical.
  const fraction = (value: string) => Number((value.match(/\.(\d+)/)?.[1] ?? '').slice(0, 6).padEnd(6, '0'));
  return fraction(a) - fraction(b);
}

async function persist(candidate: Snapshot, expectedGeneration: number): Promise<Snapshot | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const previous = await localCacheDriver.get(candidate.user_id, RUNTIME_CONFIG_KEY);
    let current: Snapshot | null = null;
    try { current = previous?.schema_version === LOCAL_CACHE_SCHEMA_VERSION
      && previous.user_id === candidate.user_id && previous.key === RUNTIME_CONFIG_KEY
      ? snapshot(JSON.parse(previous.data), candidate.user_id) : null; } catch { /* replace invalid metadata */ }
    // A slower request in another tab must not undo a newer denial/revision.
    if (current) {
      const revision = current.value && candidate.value
        ? compareRevision(current.value.updated_at, candidate.value.updated_at) : 0;
      if (revision > 0 || (revision === 0 && current.fetched_at > candidate.fetched_at)) return current;
    }
    if (await activeCacheUserId() !== candidate.user_id || generation !== expectedGeneration) return null;
    const entry: CacheEntry = { user_id: candidate.user_id, key: RUNTIME_CONFIG_KEY,
      data: JSON.stringify(candidate), last_synced_at: new Date().toISOString(), schema_version: LOCAL_CACHE_SCHEMA_VERSION };
    if (await localCacheDriver.commitCacheBatch(candidate.user_id, [entry], [],
      [{ key: RUNTIME_CONFIG_KEY, data: previous?.data ?? null }])) {
      notifySyncState(candidate.user_id);
      return candidate;
    }
  }
  throw new Error('Не удалось сохранить конфигурацию синхронизации.');
}

export async function runtimeCapabilities(userId: string, forceRefresh = false,
  { requireServer = false }: { requireServer?: boolean } = {}): Promise<Capabilities> {
  const callGeneration = generation;
  const joinedRefresh = inFlight.get(userId);
  if (!userId || await activeCacheUserId() !== userId || generation !== callGeneration) return unavailable;
  const session = (await getReadSession()).data.session;
  // Expired persisted sessions may read the device cache, but do not widen
  // the existing offline mutation authorization policy.
  if (!session || (session.expires_at && session.expires_at * 1000 <= Date.now())) return unavailable;
  if (!buildWriteEnabled() && !buildSyncEnabled()) return { write: false, sync: false, available: true };
  // Read on every evaluation: another tab's persisted false beats volatile true.
  // Changes use the existing sync-status BroadcastChannel, carrying only user ID.
  const current = snapshot(await getCached<unknown>(userId, RUNTIME_CONFIG_KEY), userId);
  if (await activeCacheUserId() !== userId || generation !== callGeneration) return unavailable;
  if (usesLocalReads())
    return requireServer || blocked.has(userId) ? unavailable : effective(current);
  let pending = joinedRefresh ?? inFlight.get(userId);
  if (!pending && !forceRefresh && !requireServer && refreshed.has(userId) && !blocked.has(userId)
    && current && Date.now() - current.fetched_at < RUNTIME_CONFIG_TTL_MS) return effective(current);

  if (!pending) {
    const expectedGeneration = generation;
    const fetchedAt = Date.now();
    pending = (async (): Promise<RefreshResult> => {
      try {
        const { data, error, status } = await supabase.rpc('get_offline_runtime_config');
        if (error) throw { ...error, status: status ?? (error as { status?: number }).status };
        const value = validate(data);
        if (await activeCacheUserId() !== userId || generation !== expectedGeneration)
          return { capabilities: unavailable, confirmed: false };
        const saved = await persist({ user_id: userId, value, fetched_at: fetchedAt }, expectedGeneration);
        if (!saved || await activeCacheUserId() !== userId || generation !== expectedGeneration)
          return { capabilities: unavailable, confirmed: false };
        refreshed.add(userId); blocked.delete(userId);
        return { capabilities: effective(saved), confirmed: saved.value !== null };
      } catch (error) {
        if (await activeCacheUserId() !== userId || generation !== expectedGeneration)
          return { capabilities: unavailable, confirmed: false };
        if (isTransportFailure(error)) {
          return { capabilities: blocked.has(userId) ? unavailable
            : effective(snapshot(await getCached<unknown>(userId, RUNTIME_CONFIG_KEY), userId)), confirmed: false };
        }
        blocked.add(userId); refreshed.delete(userId);
        // A denial tombstone survives reload; never resurrect a former true
        // after 401/403, invalid JWT or a malformed/business server reply.
        try { await persist({ user_id: userId, value: null, fetched_at: fetchedAt }, expectedGeneration); }
        catch { /* volatile block remains if storage itself is unavailable */ }
        return { capabilities: unavailable, confirmed: false };
      }
    })().finally(() => { if (inFlight.get(userId) === pending) inFlight.delete(userId); });
    inFlight.set(userId, pending);
  }
  const result = await pending;
  if (await activeCacheUserId() !== userId || generation !== callGeneration) return unavailable;
  // Replay requires fresh server confirmation, even when it joined an edit's
  // refresh that fell back to the offline snapshot.
  return requireServer && !result.confirmed ? unavailable : result.capabilities;
}
