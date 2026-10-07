import 'fake-indexeddb/auto';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ session: vi.fn(), stored: { user: { id: 'user-a' }, expires_at: 1 } as { user: { id: string }; expires_at: number } | null,
  signedOut: vi.fn(), profile: vi.fn(), changed: (_event: string, _session: unknown) => undefined as void }));
vi.mock('expo-linking', () => ({ addEventListener: () => ({ remove: vi.fn() }), getInitialURL: async () => null }));
vi.mock('@/features/auth/auth-links', () => ({ parseAuthCallbackUrl: vi.fn(), stripAuthCallbackParams: vi.fn(), createAuthRedirectUrl: vi.fn() }));
vi.mock('@/lib/supabase/realtime', () => ({ closeAllRealtimeChannels: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({
  readPersistedSession: async () => f.stored,
  clearPersistedSession: async () => { f.stored = null; },
  probeSupabaseConnectivity: vi.fn(),
  supabase: { rpc: f.profile, auth: { getSession: f.session, signOut: f.signedOut,
    onAuthStateChange: (callback: typeof f.changed) => { f.changed = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; },
  } },
}));
vi.mock('@/lib/local-cache/driver', async () => import('@/lib/local-cache/driver.web'));
import { AuthProvider, useAuth } from '@/features/auth/AuthProvider';
import { putCached } from '@/lib/local-cache/cache';
import { readAccountEpoch } from '@/lib/local-cache/read-freshness';
let renderer: ReactTestRenderer | undefined;
let api: ReturnType<typeof useAuth>;
function Consumer() { api = useAuth(); return null; }
afterEach(async () => {
  if (renderer) await act(async () => { renderer!.unmount(); });
  renderer = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks();
});
describe('offline AuthProvider startup', () => {
  it('an SDK token refresh replaces credentials while preserving the account epoch and fresh cached profile', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('navigator', { onLine: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const initial = { user: { id: 'user-a' }, expires_at: Date.now() / 1000 + 3600, access_token: 'initial-test-token' };
    f.stored = initial; f.session.mockReset().mockResolvedValue({ data: { session: initial }, error: null }); f.profile.mockClear();
    await putCached('user-a', 'profile:self', { id: 'user-a', display_name: 'Cached profile' });
    await act(async () => { renderer = create(createElement(AuthProvider, { children: createElement(Consumer) })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    expect(api.state.session?.access_token).toBe(initial.access_token);
    const epoch = readAccountEpoch();
    const refreshed = { ...initial, access_token: 'refreshed-test-token', expires_at: initial.expires_at + 3600 };
    f.stored = refreshed; f.session.mockResolvedValue({ data: { session: refreshed }, error: null });
    await act(async () => { f.changed('TOKEN_REFRESHED', refreshed); await new Promise((resolve) => setTimeout(resolve, 25)); });
    expect(api.state).toMatchObject({ user: { id: 'user-a' }, session: refreshed, profile: { display_name: 'Cached profile' }, isLoading: false, error: null });
    expect(readAccountEpoch()).toBe(epoch); expect(f.profile).not.toHaveBeenCalled();
  });
  it.each(['success', 'error'])('ignores a late initial session %s after a newer sign-in', async (outcome) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('navigator', { onLine: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let complete!: (value: unknown) => void; let reject!: (error: Error) => void;
    const pending = new Promise((resolve, fail) => { complete = resolve; reject = fail; });
    const newer = { user: { id: 'user-b' }, expires_at: Date.now() / 1000 + 3600 };
    f.stored = newer;
    f.session.mockReset().mockImplementationOnce(() => pending).mockResolvedValue({ data: { session: newer }, error: null });
    await act(async () => { renderer = create(createElement(AuthProvider, { children: createElement(Consumer) })); });
    await act(async () => { f.changed('SIGNED_IN', newer); await new Promise((resolve) => setTimeout(resolve, 25)); });
    expect(api.state.user?.id).toBe('user-b');
    await act(async () => {
      if (outcome === 'success') complete({ data: { session: { user: { id: 'user-a' } } }, error: null });
      else reject(new Error('Late restoration failed'));
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(api.state).toMatchObject({ user: { id: 'user-b' }, error: null, isLoading: false });
  });
  it('opens an expired saved session and cached profile without SDK waits, and logout clears UI/storage immediately', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('navigator', { onLine: false });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    f.stored = { user: { id: 'user-a' }, expires_at: 1 };
    f.session.mockImplementation(() => new Promise(() => undefined));
    f.signedOut.mockImplementation(() => new Promise(() => undefined)); f.profile.mockClear();
    await putCached('user-a', 'profile:self', { id: 'user-a', display_name: 'Cached profile' });
    await act(async () => { renderer = create(createElement(AuthProvider, { children: createElement(Consumer) })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    expect(api.state).toMatchObject({ isLoading: false, user: { id: 'user-a' }, profile: { display_name: 'Cached profile' } });
    expect(f.session).not.toHaveBeenCalled(); expect(f.profile).not.toHaveBeenCalled();
    await act(async () => { f.changed('INITIAL_SESSION', null); await new Promise((resolve) => setTimeout(resolve, 25)); });
    expect(api.state.user?.id).toBe('user-a');
    await act(async () => { await api.signOut(); });
    expect(api.state).toMatchObject({ isLoading: false, user: null, session: null, profile: null }); expect(f.stored).toBeNull();
  });
});
