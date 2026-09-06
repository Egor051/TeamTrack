/**
 * TaskTrace — auth operations.
 *
 * Centralizes all Supabase Auth calls. All screens use these functions
 * rather than calling the Supabase client directly.
 *
 * Validation is client-side only — it is NOT a security boundary.
 * Server-side authorization is handled via RLS.
 */

import { supabase } from '@/lib/supabase/client';
import * as Linking from 'expo-linking';

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

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        display_name: displayName,
      },
    },
  });

  if (error) {
    throw error;
  }

  return data;
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
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: Linking.createURL('reset-password'),
  });

  if (error) {
    throw error;
  }
}

/**
 * Update the current user's password.
 *
 * Used on the reset-password screen after the user opens the reset link.
 * AuthProvider consumes native deep links and restores the recovery session.
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
 * Does NOT refresh — use refreshSession() if you need a fresh token.
 */
export function getCurrentSession() {
  return supabase.auth.getSession();
}

/**
 * Get the current user synchronously.
 */
export function getCurrentUser() {
  return supabase.auth.getUser();
}

export async function updateMyProfile(displayName: string) {
  const value = displayName.trim();
  if (value.length < 2 || value.length > 80) throw new Error('Ник должен быть от 2 до 80 символов.');
  if (!/^[\p{L}\p{N}_ .-]+$/u.test(value)) throw new Error('Ник содержит недопустимые символы.');
  const { data, error } = await supabase.rpc('update_my_profile', { p_display_name: value });
  if (error) throw error;
  return data;
}
