import { supabase } from '@/lib/supabase/client';
import { activeCacheUserId } from './cache';

// A short in-memory TTL avoids repeated RPCs during an active edit session.
// Expired or unavailable configuration always disables new local writes/sync.
export const RUNTIME_CONFIG_TTL_MS = 60_000;
type RemoteConfig = { write_enabled: boolean; sync_enabled: boolean; protocol_version: number; updated_at: string };
type CachedConfig = { value: RemoteConfig; expiresAt: number };
const cache = new Map<string, CachedConfig>();

export function buildWriteEnabled(): boolean { return process.env.EXPO_PUBLIC_OFFLINE_WRITE_ENABLED === 'true'; }
export function buildSyncEnabled(): boolean { return process.env.EXPO_PUBLIC_OFFLINE_SYNC_ENABLED === 'true'; }

export function clearRuntimeConfig(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}

function validate(value: unknown): RemoteConfig {
  const row = value as Partial<RemoteConfig> | null;
  if (!row || typeof row.write_enabled !== 'boolean' || typeof row.sync_enabled !== 'boolean'
    || row.protocol_version !== 2 || typeof row.updated_at !== 'string')
    throw new Error('Некорректная конфигурация синхронизации.');
  return row as RemoteConfig;
}

export async function runtimeCapabilities(userId: string, forceRefresh = false): Promise<{
  write: boolean; sync: boolean; available: boolean;
}> {
  if (!userId || await activeCacheUserId() !== userId) return { write: false, sync: false, available: false };
  if (!buildWriteEnabled() && !buildSyncEnabled()) return { write: false, sync: false, available: true };
  let current = cache.get(userId);
  if (forceRefresh || !current || current.expiresAt <= Date.now()) {
    try {
      const { data, error } = await supabase.rpc('get_offline_runtime_config');
      if (error) throw error;
      const value = validate(data);
      if (await activeCacheUserId() !== userId) return { write: false, sync: false, available: false };
      current = { value, expiresAt: Date.now() + RUNTIME_CONFIG_TTL_MS };
      cache.set(userId, current);
    } catch {
      // A fresh fetch failure is a hard stop, even if a previous value existed.
      cache.delete(userId);
      return { write: false, sync: false, available: false };
    }
  }
  const sync = buildSyncEnabled() && current.value.sync_enabled;
  return { write: buildWriteEnabled() && sync && current.value.write_enabled, sync, available: true };
}
