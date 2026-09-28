import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-linking', () => ({
  createURL: (path: string, options?: { queryParams?: Record<string, string> }) => {
    const params = new URLSearchParams(options?.queryParams);
    return `com.teamtrack.tasktrace://${path}?${params}`;
  },
}));

import { createAuthRedirectUrl, parseAuthCallbackUrl, stripAuthCallbackParams } from '@/features/auth/auth-links';

const code = 'pkce-code_12345678';
const flowId = 'flow_id-12345678';

describe('strict PKCE auth callbacks', () => {
  it('creates an app-owned callback with an explicit purpose', () => {
    expect(createAuthRedirectUrl('recovery')).toBe('com.teamtrack.tasktrace://reset-password?auth_type=recovery');
    expect(createAuthRedirectUrl('signup')).toBe('com.teamtrack.tasktrace://login?auth_type=signup');
  });

  it('accepts the exact native recovery endpoint', () => {
    const url = `com.teamtrack.tasktrace://reset-password?auth_type=recovery&code=${code}&sb_flow_id=${flowId}`;
    expect(parseAuthCallbackUrl(url)).toEqual({ kind: 'recovery', code, flowId });
  });

  it('accepts the exact web signup endpoint', () => {
    const url = `http://127.0.0.1:8081/login?auth_type=signup&code=${code}&sb_flow_id=${flowId}`;
    const redirectFor = (kind: 'recovery' | 'signup') => `http://127.0.0.1:8081/${kind === 'signup' ? 'login' : 'reset-password'}?auth_type=${kind}`;
    expect(parseAuthCallbackUrl(url, redirectFor)).toEqual({ kind: 'signup', code, flowId });
  });

  it.each([
    `com.teamtrack.tasktrace://wrong?auth_type=recovery&code=${code}&sb_flow_id=${flowId}`,
    `other.app://reset-password?auth_type=recovery&code=${code}&sb_flow_id=${flowId}`,
    `com.teamtrack.tasktrace://login?auth_type=recovery&code=${code}&sb_flow_id=${flowId}`,
    `com.teamtrack.tasktrace://reset-password?auth_type=recovery&code=${code}`,
    `com.teamtrack.tasktrace://reset-password?auth_type=recovery&code=${code}&sb_flow_id=short`,
    `com.teamtrack.tasktrace://reset-password?auth_type=recovery&code=${code}&sb_flow_id=${flowId}&next=https://evil.example`,
    `com.teamtrack.tasktrace://reset-password?auth_type=recovery&code=${code}&code=duplicate&sb_flow_id=${flowId}`,
    `com.teamtrack.tasktrace://reset-password#access_token=stolen&refresh_token=stolen`,
  ])('rejects a callback outside the exact PKCE contract: %s', (url) => {
    expect(parseAuthCallbackUrl(url)).toBeNull();
  });

  it('removes one-time callback values from browser history', () => {
    expect(stripAuthCallbackParams(`http://127.0.0.1:8081/login?auth_type=signup&code=${code}&sb_flow_id=${flowId}&theme=dark`))
      .toBe('/login?theme=dark');
  });
});
