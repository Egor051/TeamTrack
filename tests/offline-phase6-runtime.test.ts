import { beforeEach, describe, expect, it, vi } from 'vitest';

const remote = vi.hoisted(() => ({
  userId: 'user-a', calls: 0, fail: false,
  value: { write_enabled: false, sync_enabled: false, protocol_version: 2, updated_at: '2026-09-30T00:00:00Z' },
}));
vi.mock('@/lib/local-cache/cache', () => ({ activeCacheUserId: async () => remote.userId }));
vi.mock('@/lib/supabase/client', () => ({ supabase: {
  rpc: async () => {
    remote.calls += 1;
    if (remote.fail) return { data: null, error: { message: 'Failed to fetch' } };
    return { data: { ...remote.value }, error: null };
  },
} }));

import { clearRuntimeConfig, runtimeCapabilities, RUNTIME_CONFIG_TTL_MS } from '@/lib/local-cache/runtime-config';

beforeEach(() => {
  clearRuntimeConfig();
  remote.userId = 'user-a'; remote.calls = 0; remote.fail = false;
  remote.value = { write_enabled: false, sync_enabled: false, protocol_version: 2, updated_at: '2026-09-30T00:00:00Z' };
  vi.stubEnv('EXPO_PUBLIC_OFFLINE_WRITE_ENABLED', 'false');
  vi.stubEnv('EXPO_PUBLIC_OFFLINE_SYNC_ENABLED', 'false');
  vi.useRealTimers();
});

describe('Phase 6 runtime capabilities', () => {
  it('keeps build flags as a hard ceiling and defaults remote off', async () => {
    remote.value.write_enabled = true; remote.value.sync_enabled = true;
    expect(await runtimeCapabilities('user-a')).toEqual({ write: false, sync: false, available: true });
    expect(remote.calls).toBe(0);
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_SYNC_ENABLED', 'true');
    expect(await runtimeCapabilities('user-a')).toEqual({ write: false, sync: true, available: true });
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_WRITE_ENABLED', 'true');
    expect(await runtimeCapabilities('user-a')).toEqual({ write: true, sync: true, available: true });
  });

  it('stops writes when remote sync is off while permitting queue drain mode', async () => {
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_WRITE_ENABLED', 'true');
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_SYNC_ENABLED', 'true');
    remote.value.write_enabled = true;
    expect(await runtimeCapabilities('user-a')).toMatchObject({ write: false, sync: false });
    remote.value.sync_enabled = true; remote.value.write_enabled = false;
    expect(await runtimeCapabilities('user-a', true)).toMatchObject({ write: false, sync: true });
  });

  it('fails closed when config expires or a forced reconnect fetch fails', async () => {
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_WRITE_ENABLED', 'true');
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_SYNC_ENABLED', 'true');
    remote.value.write_enabled = true; remote.value.sync_enabled = true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T00:00:00Z'));
    expect((await runtimeCapabilities('user-a')).write).toBe(true);
    remote.fail = true;
    vi.setSystemTime(new Date(Date.now() + RUNTIME_CONFIG_TTL_MS + 1));
    expect(await runtimeCapabilities('user-a')).toEqual({ write: false, sync: false, available: false });
    expect(remote.calls).toBe(2);
  });

  it('never shares a cached capability between accounts', async () => {
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_WRITE_ENABLED', 'true');
    vi.stubEnv('EXPO_PUBLIC_OFFLINE_SYNC_ENABLED', 'true');
    remote.value.write_enabled = true; remote.value.sync_enabled = true;
    expect((await runtimeCapabilities('user-a')).write).toBe(true);
    remote.userId = 'user-b'; remote.value.write_enabled = false;
    expect(await runtimeCapabilities('user-a')).toEqual({ write: false, sync: false, available: false });
    expect((await runtimeCapabilities('user-b')).write).toBe(false);
  });
});
