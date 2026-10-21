import { afterEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ user: vi.fn(), session: vi.fn(), logout: vi.fn(), clear: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { auth: { getUser: f.user, getSession: f.session, signOut: f.logout } }, clearPersistedSession: f.clear }));
vi.mock('@/features/auth/auth-links', () => ({ createAuthRedirectUrl: vi.fn() }));
import { getVerifiedCurrentUser as getCurrentUser, getCurrentUser as getSessionIdentity, signOut } from '@/features/auth/auth';
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
describe('offline identity', () => {
  it('uses only a valid persisted session on transport failure', async () => {
    f.user.mockResolvedValue({ data: { user: null }, error: { status: 0, message: 'Failed to fetch' } });
    f.session.mockResolvedValue({ data: { session: { user: { id: 'user-a' }, expires_at: Math.floor(Date.now() / 1000) + 60 } }, error: null });
    expect(await getCurrentUser()).toMatchObject({ data: { user: { id: 'user-a' } }, error: null });
  });
  it('never substitutes a session for a known 401/403 and rejects an expired offline session', async () => {
    f.user.mockResolvedValue({ data: { user: null }, error: { status: 403, message: 'Denied' } });
    expect((await getCurrentUser()).error).toMatchObject({ status: 403 }); expect(f.session).not.toHaveBeenCalled();
    f.user.mockRejectedValue({ status: 0, message: 'Failed to fetch' });
    f.session.mockResolvedValue({ data: { session: { user: { id: 'user-a' }, expires_at: 1 } }, error: null });
    await expect(getCurrentUser()).rejects.toMatchObject({ message: 'Failed to fetch' });
  });
});

it('ordinary identity reads reuse the session without an auth user HTTP request', async () => {
  f.session.mockResolvedValue({ data: { session: { user: { id: 'user-a' }, expires_at: Math.floor(Date.now() / 1000) + 60 } }, error: null });
  for (let i = 0; i < 5; i++) expect(await getSessionIdentity()).toMatchObject({ data: { user: { id: 'user-a' } }, error: null });
  expect(f.user).not.toHaveBeenCalled();
});
it('BUG-05 releases local logout when the SDK never settles, without waiting for server revocation', async () => {
  vi.useFakeTimers(); f.clear.mockResolvedValue(undefined);
  f.logout.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue({ error: null });
  const pending = signOut(); await vi.advanceTimersByTimeAsync(10_000); await pending;
  expect(f.clear).toHaveBeenCalledOnce(); expect(f.logout).toHaveBeenCalledTimes(2);
});
