/**
 * TaskTrace — auth operations.
 *
 * Centralizes all Supabase Auth calls. All screens use these functions
 * rather than calling the Supabase client directly.
 *
 * Validation is client-side only — it is NOT a security boundary.
 * Server-side authorization is handled via RLS.
 */

import { supabase, clearPersistedSession } from '@/lib/supabase/client';
import { createAuthRedirectUrl } from './auth-links';
import { isTransportFailure } from '@/lib/local-cache/cache';
import { sendAuthEmail } from './email-cooldown';
import { getReadSession } from '@/lib/supabase/session';
import { usesLocalReads, reportConnectivityFailure } from '@/lib/connectivity/state';

export type SignUpInput = {
  email: string;
  password: string;
  displayName: string;
};

export type SignInInput = {
  email: string;
  password: string;
};

export type ResetPasswordInput = {
  newPassword: string;
};

/**
 * Sign up a new user.
 *
 * Supabase Auth creates the auth.users row.
 * The database trigger `on_auth_user_created` provisions the profiles row
 * using raw_user_meta_data.display_name.
 *
 * After sign-up, the user is immediately logged in (session returned).
 * Supabase may also be configured to require email confirmation — in that
 * case, session.user.email_confirmed_at will be null.
 */
export async function signUp(input: SignUpInput) {
  const { email, password, displayName } = input;
  return sendAuthEmail('signup', email, async () => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: createAuthRedirectUrl('signup'),
        data: {
          display_name: displayName,
        },
      },
    });
    if (error) throw error;
    return data;
  }, (data) => !data.session);
}

export async function resendConfirmation(email: string) {
  return sendAuthEmail('signup', email, async () => {
    const { error } = await supabase.auth.resend({
      type: 'signup', email,
      options: { emailRedirectTo: createAuthRedirectUrl('signup') },
    });
    if (error) throw error;
  });
}

/**
 * Sign in with email + password.
 *
 * Returns session on success. Throws on failure.
 */
export async function signIn(input: SignInInput) {
  const { email, password } = input;

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Sign out the current user.
 *
 * Invalidates the local session and clears persisted tokens.
 */
export async function signOut() {
  if (usesLocalReads()) {
    await clearPersistedSession();
    // Explicit logout clears the namespace now, even if an SDK refresh is
    // still retrying. Its commit guard cannot resurrect the removed session.
    void supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
    return;
  }
  // Keep other devices signed in; this client explicitly clears its own
  // persisted session and AuthProvider tears down local realtime channels.
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) {
    throw error;
  }
}

/**
 * Request a password reset email.
 *
 * Supabase sends a reset email to the provided address.
 * The email contains a link that opens reset-password.tsx via deep link.
 */
export async function requestPasswordReset(email: string) {
  return sendAuthEmail('recovery', email, async () => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: createAuthRedirectUrl('recovery'),
    });
    if (error) throw error;
  });
}

/**
 * Update the current user's password.
 *
 * Used on the reset-password screen after the user opens the reset link.
 * AuthProvider validates the web/native callback and exchanges its PKCE code.
 */
export async function updatePassword(newPassword: string) {
  const { data, error } = await supabase.auth.updateUser({
    password: newPassword,
  });

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Refresh the current session.
 *
 * Useful when you need to ensure the session is fresh before a critical
 * operation (e.g. before calling an RPC).
 */
export async function refreshSession() {
  const { data, error } = await supabase.auth.refreshSession();
  if (error) {
    throw error;
  }
  return data;
}

/**
 * Get the current session synchronously.
 *
 * Returns null if no session is persisted.
 * Offline reads restore storage without SDK refresh/initialization waits.
 * Online getSession may refresh an expiring token, as required by the SDK.
 */
export function getCurrentSession() {
  return getReadSession();
}

/**
 * Get the current user synchronously.
 */
export async function getCurrentUser() {
  // Identity selects a user namespace/filter. It never grants server access;
  // every online query/mutation is still authenticated and checked by RLS/RPC.
  const { data, error } = await getReadSession();
  const session = data.session;
  if (error) return { data: { user: null }, error };
  if (!session || (!usesLocalReads() && session.expires_at && session.expires_at * 1000 <= Date.now()))
    return { data: { user: null }, error: Object.assign(new Error('Требуется авторизация.'), { status: 401 }) };
  return { data: { user: session.user }, error: null };
}

/** Obtain a fresh Auth user record when authoritative verification is needed. */
export async function getVerifiedCurrentUser() {
  if (usesLocalReads()) {
    const { data, error } = await getReadSession();
    return { data: { user: data.session?.user ?? null }, error };
  }
  // Use the persisted authenticated identity only when transport is unavailable.
  // Server authorization remains RLS/RPC; JWT/access failures never fall back.
  try {
    const result = await supabase.auth.getUser();
    if (!result.error || !isTransportFailure(result.error)) return result;
    throw result.error;
  } catch (error) {
    if (!isTransportFailure(error)) throw error;
    reportConnectivityFailure(error);
    const { data, error: sessionError } = await getReadSession();
    if (sessionError || !data.session?.user || (data.session.expires_at && data.session.expires_at * 1000 <= Date.now())) throw error;
    return { data: { user: data.session.user }, error: null };
  }
}

export async function updateMyProfile(displayName: string) {
  const value = displayName.trim();
  if (value.length < 2 || value.length > 80) throw new Error('Ник должен быть от 2 до 80 символов.');
  if (!/^[\p{L}\p{N}_ .-]+$/u.test(value)) throw new Error('Ник содержит недопустимые символы.');
  const { data, error } = await supabase.rpc('update_my_profile', { p_display_name: value });
  if (error) throw error;
  return data;
}
