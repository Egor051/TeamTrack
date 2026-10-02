import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { emailSendRetryDelay, mapSupabaseAuthError } from '@/lib/errors/auth-errors';

const f = vi.hoisted(() => ({ values: new Map<string, string>(), get: vi.fn(), set: vi.fn(), remove: vi.fn(),
  signup: vi.fn(), resend: vi.fn(), recover: vi.fn() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: f.get, setItem: f.set, removeItem: f.remove } }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { auth: { signUp: f.signup, resend: f.resend, resetPasswordForEmail: f.recover } } }));
vi.mock('@/lib/local-cache/cache', () => ({ isTransportFailure: vi.fn() }));
vi.mock('@/features/auth/auth-links', () => ({ createAuthRedirectUrl: (flow: string) => `https://tasktrace.test/${flow}` }));

let cooldown: typeof import('@/features/auth/email-cooldown');
let auth: typeof import('@/features/auth/auth');
const email = 'Person@example.com';
const rateLimit = (seconds: number) => ({ code: 'over_email_send_rate_limit', status: 429,
  message: `For security purposes, you can only request this after ${seconds} seconds.` });
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T10:00:00Z'));
  f.values.clear();
  f.get.mockImplementation(async (key) => f.values.get(key) ?? null);
  f.set.mockImplementation(async (key, value) => { f.values.set(key, value); });
  f.remove.mockImplementation(async (key) => { f.values.delete(key); });
  f.signup.mockResolvedValue({ data: { session: null, user: { id: 'user' } }, error: null });
  f.resend.mockResolvedValue({ error: null }); f.recover.mockResolvedValue({ error: null });
  cooldown = await import('@/features/auth/email-cooldown'); auth = await import('@/features/auth/auth');
});
afterEach(() => { vi.useRealTimers(); });

describe('Auth email sending and persistence', () => {
  it('starts 60 seconds after confirmed success and computes 59 after one second', async () => {
    await auth.requestPasswordReset(email);
    const key = cooldown.authEmailCooldownKey('recovery', email);
    const until = Number(f.values.get(key));
    expect(until).toBe(Date.now() + 60_000);
    expect(cooldown.cooldownSeconds(until)).toBe(60);
    vi.advanceTimersByTime(1000);
    expect(cooldown.cooldownSeconds(until)).toBe(59);
    expect(f.recover).toHaveBeenCalledWith(email, { redirectTo: 'https://tasktrace.test/recovery' });
  });
  it('shares signup confirmation cooldown with resend and preserves PKCE redirect options', async () => {
    await auth.signUp({ email, password: 'Password1', displayName: 'Person' });
    expect(f.signup).toHaveBeenCalledWith({ email, password: 'Password1', options: {
      emailRedirectTo: 'https://tasktrace.test/signup', data: { display_name: 'Person' },
    } });
    await expect(auth.resendConfirmation(' person@EXAMPLE.com ')).rejects.toMatchObject({ code: 'auth_email_cooldown' });
    expect(f.resend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    await auth.resendConfirmation(email);
    expect(f.resend).toHaveBeenCalledWith({ email, type: 'signup', options: { emailRedirectTo: 'https://tasktrace.test/signup' } });
  });
  it('does not start confirmation cooldown for immediate-session signup', async () => {
    f.signup.mockResolvedValue({ data: { session: { user: { id: 'user' } } }, error: null });
    await auth.signUp({ email, password: 'Password1', displayName: 'Person' });
    expect(f.set).not.toHaveBeenCalled();
  });
  it.each([
    { code: 'network_error', message: 'Failed to fetch' },
    { code: 'unexpected_failure', message: 'Error sending recovery email', status: 500 },
    { code: 'email_address_invalid', message: 'Invalid email' },
    { code: 'over_request_rate_limit', message: 'Too many requests', status: 429 },
    { code: 'over_email_send_rate_limit', message: 'email rate limit exceeded', status: 429 },
  ])('preserves errors without inventing a deadline: $code / $message', async (error) => {
    f.recover.mockResolvedValue({ error });
    await expect(auth.requestPasswordReset(email)).rejects.toEqual(error);
    expect(f.set).not.toHaveBeenCalled();
    expect(await cooldown.readEmailCooldown(cooldown.authEmailCooldownKey('recovery', email))).toBe(0);
    if (error.code === 'over_email_send_rate_limit' || error.code === 'over_request_rate_limit') {
      expect(mapSupabaseAuthError(error)).not.toContain(error.message);
    }
  });
  it('restores a server frequency deadline without claiming a successful send', async () => {
    f.resend.mockResolvedValue({ error: rateLimit(22) });
    await expect(auth.resendConfirmation(email)).rejects.toEqual(rateLimit(22));
    const key = cooldown.authEmailCooldownKey('signup', email);
    // GoTrue truncates the fractional second: 22 means between 22 and 23.
    expect(Number(f.values.get(key))).toBe(Date.now() + 23_000);
    expect(mapSupabaseAuthError(rateLimit(22))).toContain('Письмо уже было отправлено');
    expect(mapSupabaseAuthError(rateLimit(22))).not.toContain('For security purposes');
  });
  it('restores persistence after reloading all modules', async () => {
    await auth.requestPasswordReset(email);
    vi.advanceTimersByTime(15_000); vi.resetModules();
    const reloaded = await import('@/features/auth/email-cooldown');
    expect(reloaded.cooldownSeconds(await reloaded.readEmailCooldown(reloaded.authEmailCooldownKey('recovery', email)))).toBe(45);
    const reloadedAuth = await import('@/features/auth/auth');
    await expect(reloadedAuth.requestPasswordReset(email)).rejects.toMatchObject({ code: 'auth_email_cooldown' });
    expect(f.recover).toHaveBeenCalledTimes(1);
  });
  it.each(['expired', 'malformed'])('removes %s persistence and allows sending', async (kind) => {
    const key = cooldown.authEmailCooldownKey('recovery', email);
    f.values.set(key, kind === 'expired' ? String(Date.now() - 1) : 'not a timestamp');
    expect(await cooldown.readEmailCooldown(key)).toBe(0);
    expect(f.values.has(key)).toBe(false);
    await auth.requestPasswordReset(email);
    expect(f.recover).toHaveBeenCalledTimes(1);
  });
  it('does not mix different emails or independent confirmation/recovery flows', async () => {
    await auth.requestPasswordReset(email);
    await auth.requestPasswordReset('another@example.com');
    await auth.resendConfirmation(email);
    expect(f.values.size).toBe(3);
  });
  it('rejects parallel requests for the same normalized operation/email', async () => {
    let finish!: (value: { error: null }) => void;
    f.recover.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const first = auth.requestPasswordReset(email);
    const second = auth.requestPasswordReset(' person@EXAMPLE.com ');
    await expect(second).rejects.toMatchObject({ code: 'auth_email_request_pending' });
    // Drain the asynchronous persistence check before resolving the request.
    await vi.waitFor(() => expect(f.recover).toHaveBeenCalledTimes(1));
    finish({ error: null }); await first;
    expect(cooldown.emailRequestPending(cooldown.authEmailCooldownKey('recovery', email))).toBe(false);
  });
  it('does not report storage write failure as SMTP failure and keeps a memory fallback', async () => {
    f.set.mockRejectedValue(new Error('Storage unavailable'));
    await expect(auth.requestPasswordReset(email)).resolves.toBeUndefined();
    f.get.mockRejectedValue(new Error('Storage unavailable'));
    const key = cooldown.authEmailCooldownKey('recovery', email);
    expect(cooldown.cooldownSeconds(await cooldown.readEmailCooldown(key))).toBe(60);
    await expect(auth.requestPasswordReset(email)).rejects.toMatchObject({ code: 'auth_email_cooldown' });
  });
});

describe('only reliable per-user remaining time is parsed', () => {
  it('handles the final fractional second', () => { expect(emailSendRetryDelay(rateLimit(0))).toBe(1000); });
  it.each([
    { code: 'over_email_send_rate_limit', message: 'Email rate limit exceeded, 30 emails per hour' },
    { code: 'over_email_send_rate_limit', message: 'For security purposes, you can only request this once every 60 seconds' },
    { code: 'over_request_rate_limit', message: rateLimit(20).message },
    { code: 'unexpected_failure', message: rateLimit(20).message },
    rateLimit(999999999999999), null,
  ])('does not infer seconds from unrelated or unrecognized errors: %j', (error) => {
    expect(emailSendRetryDelay(error)).toBeNull();
  });
});
