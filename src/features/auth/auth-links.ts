import * as Linking from 'expo-linking';

export type AuthCallbackKind = 'recovery' | 'signup';
export type AuthCallback = {
  kind: AuthCallbackKind;
  code: string;
  flowId: string;
};

const CALLBACK_PATHS: Record<AuthCallbackKind, string> = {
  recovery: 'reset-password',
  signup: 'login',
};
const FLOW_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const AUTH_CODE_PATTERN = /^[A-Za-z0-9._~-]{8,4096}$/;
const ALLOWED_PARAMS = new Set(['auth_type', 'code', 'sb_flow_id']);

export function createAuthRedirectUrl(kind: AuthCallbackKind): string {
  return Linking.createURL(CALLBACK_PATHS[kind], {
    queryParams: { auth_type: kind },
  });
}

function sameCallbackEndpoint(actual: URL, expected: URL): boolean {
  return actual.protocol === expected.protocol
    && actual.hostname === expected.hostname
    && actual.port === expected.port
    && actual.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '');
}

/**
 * Accepts only our exact platform callback endpoint and the PKCE parameters
 * produced by Supabase. Fragments and implicit-flow tokens are deliberately
 * rejected so an arbitrary app link can never install a session.
 */
export function parseAuthCallbackUrl(
  rawUrl: string,
  redirectFor = createAuthRedirectUrl,
): AuthCallback | null {
  let actual: URL;
  try {
    actual = new URL(rawUrl);
  } catch {
    return null;
  }
  if (actual.username || actual.password || actual.hash) return null;

  for (const key of actual.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(key) || actual.searchParams.getAll(key).length !== 1) return null;
  }

  const kind = actual.searchParams.get('auth_type');
  if (kind !== 'recovery' && kind !== 'signup') return null;

  let expected: URL;
  try {
    expected = new URL(redirectFor(kind));
  } catch {
    return null;
  }
  if (!sameCallbackEndpoint(actual, expected)) return null;

  const code = actual.searchParams.get('code') ?? '';
  const flowId = actual.searchParams.get('sb_flow_id') ?? '';
  if (!AUTH_CODE_PATTERN.test(code) || !FLOW_ID_PATTERN.test(flowId)) return null;
  return { kind, code, flowId };
}

export function stripAuthCallbackParams(rawUrl: string): string {
  const url = new URL(rawUrl);
  for (const key of ALLOWED_PARAMS) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}` || '/';
}
