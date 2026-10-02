import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ values: new Map<string, string>(), get: vi.fn(), set: vi.fn(), remove: vi.fn(),
  signup: vi.fn(), resend: vi.fn(), recover: vi.fn(), signIn: vi.fn(), appState: vi.fn(), removeState: vi.fn(), replace: vi.fn(),
  foreground: (_state: string) => undefined as void }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: f.get, setItem: f.set, removeItem: f.remove } }));
vi.mock('react-native', () => ({ ActivityIndicator: 'Spinner', Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles }, AppState: { addEventListener: f.appState } }));
vi.mock('expo-router', () => ({ router: { replace: f.replace } }));
vi.mock('@/components/ui/theme-provider', () => ({ useTheme: () => ({ colors: {} }) }));
vi.mock('@/components/ui/text', () => ({ ThemedText: 'Text' }));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
vi.mock('@/components/ui/error-message', () => ({ ErrorMessage: 'ErrorMessage' }));
vi.mock('@/features/auth/components/auth-form', () => ({
  AuthForm: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => createElement('Form', null, children, footer),
  AuthNotice: ({ children, title }: { children: ReactNode; title: string }) => createElement('Notice', { accessibilityLiveRegion: 'polite' }, title, children),
  AuthLink: 'Link', readAuthInputValue: (ref: { current: { value?: string } | null }, fallback: string) => ref.current?.value ?? fallback,
}));
vi.mock('@/lib/supabase/client', () => ({ supabase: { auth: { signUp: f.signup, resend: f.resend, resetPasswordForEmail: f.recover } } }));
vi.mock('@/lib/local-cache/cache', () => ({ isTransportFailure: vi.fn() }));
vi.mock('@/features/auth/auth-links', () => ({ createAuthRedirectUrl: (flow: string) => `https://tasktrace.test/${flow}` }));
vi.mock('@/features/auth/AuthProvider', async () => {
  const auth = await import('@/features/auth/auth');
  return { useAuth: () => ({ state: { error: null, session: null }, clearError: vi.fn(),
    signUp: (email: string, password: string, displayName: string) => auth.signUp({ email, password, displayName }),
    requestPasswordReset: auth.requestPasswordReset, resendConfirmation: auth.resendConfirmation, signIn: f.signIn,
  }) };
});

import ForgotPassword from '@/app/(auth)/forgot-password';
import Register from '@/app/(auth)/register';
import Login from '@/app/(auth)/login';
import { useEmailCooldown } from '@/features/auth/use-email-cooldown';
import { authEmailCooldownKey } from '@/features/auth/email-cooldown';

const renderers: ReactTestRenderer[] = [];
let testIndex = 0;
let testWindow: EventTarget;
let testDocument: EventTarget & { visibilityState: string };
let hookState!: ReturnType<typeof useEmailCooldown>;
function Probe({ email = 'probe@example.com' }: { email?: string }) { hookState = useEmailCooldown('recovery', email); return null; }
async function mount(component: typeof ForgotPassword | typeof Probe) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(component)); });
  renderers.push(renderer); return renderer;
}
async function fill(renderer: ReactTestRenderer, label: string, value: string) {
  await act(async () => { renderer.root.findByProps({ label }).props.onChangeText(value); });
}
function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByProps({ accessibilityRole: 'button' }).find((node) =>
    node.findAll((child) => typeof child.props.children === 'string' && child.props.children.includes(label)).length > 0)!;
}
async function press(renderer: ReactTestRenderer, label: string) {
  await act(async () => { button(renderer, label).props.onPress(); });
}
function body(renderer: ReactTestRenderer) { return JSON.stringify(renderer.toJSON()); }
async function tick(ms: number) { await act(async () => { vi.advanceTimersByTime(ms); }); }

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T10:00:00Z').getTime() + (++testIndex * 120_000));
  f.values.clear(); f.get.mockImplementation(async (key) => f.values.get(key) ?? null);
  f.set.mockImplementation(async (key, value) => { f.values.set(key, value); });
  f.remove.mockImplementation(async (key) => { f.values.delete(key); });
  f.signup.mockResolvedValue({ data: { session: null }, error: null });
  f.resend.mockResolvedValue({ error: null }); f.recover.mockResolvedValue({ error: null });
  f.appState.mockImplementation((_event, callback) => { f.foreground = callback; return { remove: f.removeState }; });
  testWindow = new EventTarget(); testDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('window', testWindow); vi.stubGlobal('document', testDocument); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const originalError = console.error.bind(console);
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (String(args[0]).includes('react-test-renderer is deprecated')) return;
    originalError(...args);
  });
});
afterEach(async () => {
  await act(async () => { renderers.splice(0).forEach((renderer) => renderer.unmount()); });
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('email screens use the existing Button and accessible cooldown', () => {
  it('recovery success: disabled at 60/59, enabled after expiry, resend restarts the deadline', async () => {
    const renderer = await mount(ForgotPassword); await fill(renderer, 'Email', 'person@example.com');
    await press(renderer, 'Отправить ссылку');
    expect(button(renderer, 'через 60 с').props.disabled).toBe(true);
    expect(button(renderer, 'через 60 с').props.accessibilityState.disabled).toBe(true);
    expect(button(renderer, 'через 60 с').props.accessibilityLiveRegion).toBe('none');
    expect(button(renderer, 'через 60 с').props.accessibilityLabel).not.toContain('60');
    // Even invoking a disabled handler / Enter cannot send another request.
    await press(renderer, 'через 60 с'); expect(f.recover).toHaveBeenCalledTimes(1);
    await tick(1000); expect(button(renderer, 'через 59 с').props.disabled).toBe(true);
    await tick(59_000); expect(button(renderer, 'Отправить повторно').props.disabled).toBe(false);
    expect(f.values.size).toBe(0);
    await press(renderer, 'Отправить повторно'); expect(f.recover).toHaveBeenCalledTimes(2);
    expect(button(renderer, 'через 60 с').props.disabled).toBe(true);
  });
  it('restores after navigation/remount and does not block a different address', async () => {
    let renderer = await mount(ForgotPassword); await fill(renderer, 'Email', 'person@example.com');
    await press(renderer, 'Отправить ссылку');
    await act(async () => { renderer.unmount(); }); renderers.pop();
    await tick(10_000); renderer = await mount(ForgotPassword);
    await fill(renderer, 'Email', ' PERSON@example.com ');
    expect(button(renderer, 'через 50 с').props.disabled).toBe(true);
    await fill(renderer, 'Email', 'another@example.com');
    expect(button(renderer, 'Отправить ссылку').props.disabled).toBe(false);
  });
  it('has no cooldown on failed SMTP/network send', async () => {
    f.recover.mockResolvedValue({ error: { code: 'network_error', message: 'Failed to fetch' } });
    const renderer = await mount(ForgotPassword); await fill(renderer, 'Email', 'person@example.com');
    await press(renderer, 'Отправить ссылку');
    expect(button(renderer, 'Отправить ссылку').props.disabled).toBe(false);
    expect(body(renderer)).toContain('Сетевая ошибка'); expect(body(renderer)).not.toContain('Failed to fetch');
    expect(f.set).not.toHaveBeenCalled();
  });
  it('renders server frequency-limit error in Russian and restores its deadline', async () => {
    f.recover.mockResolvedValue({ error: { code: 'over_email_send_rate_limit',
      message: 'For security purposes, you can only request this after 12 seconds.' } });
    const renderer = await mount(ForgotPassword); await fill(renderer, 'Email', 'person@example.com');
    await press(renderer, 'Отправить ссылку');
    expect(body(renderer)).toContain('Письмо уже было отправлено'); expect(body(renderer)).not.toContain('For security purposes');
    expect(body(renderer)).not.toContain('Проверьте почту'); expect(button(renderer, 'через 13 с').props.disabled).toBe(true);
  });
  it('does not assign seconds to the global email limit', async () => {
    f.recover.mockResolvedValue({ error: { code: 'over_email_send_rate_limit', message: 'Email rate limit exceeded' } });
    const renderer = await mount(ForgotPassword); await fill(renderer, 'Email', 'person@example.com');
    await press(renderer, 'Отправить ссылку');
    expect(body(renderer)).toContain('Отправка писем временно ограничена');
    expect(body(renderer)).not.toContain('Email rate limit exceeded'); expect(body(renderer)).not.toContain('через');
    expect(f.set).not.toHaveBeenCalled();
  });
  it('blocks concurrent clicks while the request is pending', async () => {
    let finish!: (value: { error: null }) => void;
    f.recover.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const renderer = await mount(ForgotPassword); await fill(renderer, 'Email', 'person@example.com');
    await press(renderer, 'Отправить ссылку');
    expect(button(renderer, 'Отправляем ссылку…').props.disabled).toBe(true);
    expect(button(renderer, 'Отправляем ссылку…').props.accessibilityState.busy).toBe(true);
    await press(renderer, 'Отправляем ссылку…'); expect(f.recover).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ error: null }); });
  });
  it('offers confirmation resend after signup and shares its initial 60-second deadline', async () => {
    const renderer = await mount(Register);
    await fill(renderer, 'Имя', 'Person'); await fill(renderer, 'Email', 'person@example.com');
    await fill(renderer, 'Пароль', 'Password1'); await fill(renderer, 'Повторите пароль', 'Password1');
    await press(renderer, 'Создать аккаунт');
    expect(body(renderer)).toContain('Проверьте почту'); expect(button(renderer, 'через 60 с').props.disabled).toBe(true);
    await tick(60_000); await press(renderer, 'Отправить повторно');
    expect(f.resend).toHaveBeenCalledTimes(1); expect(button(renderer, 'через 60 с').props.disabled).toBe(true);
  });
  it('offers resend on login only for email_not_confirmed and clears it when email changes', async () => {
    f.signIn.mockRejectedValue({ code: 'email_not_confirmed', message: 'Email not confirmed' });
    const renderer = await mount(Login); await fill(renderer, 'Email', 'person@example.com'); await fill(renderer, 'Пароль', 'Password1');
    await press(renderer, 'Войти'); expect(button(renderer, 'Отправить повторно').props.disabled).toBe(false);
    await press(renderer, 'Отправить повторно'); expect(f.resend).toHaveBeenCalledTimes(1);
    expect(button(renderer, 'через 60 с').props.disabled).toBe(true);
    await fill(renderer, 'Email', 'other@example.com'); expect(body(renderer)).not.toContain('Отправить повторно');
    f.signIn.mockRejectedValue({ code: 'invalid_login_credentials' }); await press(renderer, 'Войти');
    expect(body(renderer)).not.toContain('Отправить повторно');
  });
});

describe('cooldown lifecycle', () => {
  it('ignores expired persistence on mount and cleans timers/listeners on unmount', async () => {
    const key = authEmailCooldownKey('recovery', 'probe@example.com'); f.values.set(key, String(Date.now() - 1));
    const renderer = await mount(Probe); expect(hookState.disabled).toBe(false); expect(f.values.has(key)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { renderer.unmount(); }); renderers.pop(); expect(f.removeState).toHaveBeenCalled();
  });
  it.each(['focus', 'visibility', 'native'])('recomputes from real time on %s resume without replaying ticks', async (resume) => {
    const key = authEmailCooldownKey('recovery', 'probe@example.com'); f.values.set(key, String(Date.now() + 60_000));
    const renderer = await mount(Probe); expect(hookState.remainingSeconds).toBe(60);
    expect(vi.getTimerCount()).toBe(1);
    vi.setSystemTime(Date.now() + 61_000);
    await act(async () => {
      if (resume === 'focus') testWindow.dispatchEvent(new Event('focus'));
      else if (resume === 'visibility') testDocument.dispatchEvent(new Event('visibilitychange'));
      else f.foreground('active');
    });
    expect(hookState.disabled).toBe(false); expect(hookState.remainingSeconds).toBe(0); expect(vi.getTimerCount()).toBe(0);
    await act(async () => { renderer.unmount(); }); renderers.pop();
  });
  it('applies another tab storage update', async () => {
    await mount(Probe);
    const key = authEmailCooldownKey('recovery', 'probe@example.com'); f.values.set(key, String(Date.now() + 60_000));
    await act(async () => { testWindow.dispatchEvent(Object.assign(new Event('storage'), { key })); });
    expect(hookState.remainingSeconds).toBe(60); expect(hookState.disabled).toBe(true);
  });
  it('starts disabled while persistence is loading, and ignores a late read after unmount', async () => {
    let finish!: (value: null) => void;
    f.get.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const renderer = await mount(Probe); expect(hookState.disabled).toBe(true);
    await act(async () => { renderer.unmount(); }); renderers.pop();
    await act(async () => { finish(null); }); expect(vi.getTimerCount()).toBe(0);
  });
});
