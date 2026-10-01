import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ user: 'user-a', update: vi.fn(), put: vi.fn(),
  authChanged: (_event: string, _session: unknown) => undefined as void }));
vi.mock('expo-linking', () => ({ addEventListener: () => ({ remove: vi.fn() }), getInitialURL: async () => null }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { auth: {
  onAuthStateChange: (callback: typeof f.authChanged) => {
    f.authChanged = callback; return { data: { subscription: { unsubscribe: vi.fn() } } };
  },
} } }));
vi.mock('@/lib/supabase/realtime', () => ({ closeAllRealtimeChannels: vi.fn() }));
vi.mock('@/features/auth/auth-links', () => ({ parseAuthCallbackUrl: vi.fn(), stripAuthCallbackParams: vi.fn() }));
vi.mock('@/features/auth/auth', () => ({
  getCurrentSession: async () => ({ data: { session: { user: { id: f.user } } }, error: null }),
  updateMyProfile: f.update, signUp: vi.fn(), signIn: vi.fn(), signOut: vi.fn(),
  requestPasswordReset: vi.fn(), updatePassword: vi.fn(), refreshSession: vi.fn(),
}));
vi.mock('@/lib/local-cache/cache', () => ({ activeCacheUserId: async () => f.user, putCached: f.put,
  readThroughCache: async () => ({ id: f.user, display_name: `Profile ${f.user}` }),
}));

import { AuthProvider, useAuth } from '@/features/auth/AuthProvider';
let api: ReturnType<typeof useAuth>;
let renderer: ReactTestRenderer;
function Consumer() { api = useAuth(); return null; }
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  f.user = 'user-a'; f.update.mockReset(); f.put.mockReset();
  await act(async () => { renderer = create(createElement(AuthProvider, { children: createElement(Consumer) })); });
  await act(async () => { await vi.runAllTimersAsync(); });
});
afterEach(async () => {
  await act(async () => { renderer.unmount(); });
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
describe('profile mutation cache isolation', () => {
  it('never writes the previous account profile into a newly signed-in account', async () => {
    let finish!: (value: { id: string; display_name: string }) => void;
    f.update.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = api.updateProfile('Changed A'); });
    expect(f.update).toHaveBeenCalledWith('Changed A');
    f.user = 'user-b';
    await act(async () => { f.authChanged('SIGNED_IN', { user: { id: f.user } }); await vi.runAllTimersAsync(); });
    await act(async () => { finish({ id: 'user-a', display_name: 'Changed A' }); await pending; });
    expect(f.put).not.toHaveBeenCalled();
    expect(api.state).toMatchObject({ user: { id: 'user-b' }, profile: { id: 'user-b', display_name: 'Profile user-b' } });
  });
  it('updates the current account profile and its own snapshot normally', async () => {
    const profile = { id: 'user-a', display_name: 'Changed A' };
    f.update.mockResolvedValue(profile);
    await act(async () => { await api.updateProfile('Changed A'); });
    expect(f.put).toHaveBeenCalledWith('user-a', 'profile:self', profile);
    expect(api.state.profile).toMatchObject(profile);
  });
});
