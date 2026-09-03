import React, { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import * as Linking from 'expo-linking';
import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase/client';
import type { Profile } from '@/lib/supabase/client';
import type { AuthState } from './types';
import { mapSupabaseAuthError } from '@/lib/errors/auth-errors';
import {
  signUp as authSignUp,
  signIn as authSignIn,
  signOut as authSignOut,
  requestPasswordReset as authRequestPasswordReset,
  updatePassword as authUpdatePassword,
  refreshSession as authRefreshSession,
  getCurrentSession,
} from './auth';
import { closeAllRealtimeChannels } from '@/lib/supabase/realtime';

type AuthContextType = {
  state: AuthState;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
  refreshSession: () => Promise<void>;
  clearError: () => void;
};

const initialState: AuthState = {
  isLoading: true,
  session: null,
  user: null,
  profile: null,
  error: null,
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

async function fetchProfile(userId: string): Promise<Profile | null> {
  try {
    const { data, error } = await supabase
      .from('profiles').select('*').eq('id', userId).single();
    if (error) {
      if (process.env.NODE_ENV !== 'production') console.debug('[AuthProvider] profile fetch error:', error.message);
      return null;
    }
    return data;
  } catch {
    if (process.env.NODE_ENV !== 'production') console.debug('[AuthProvider] profile fetch exception');
    return null;
  }
}

function parseLinkParams(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  const source = url.includes('#') ? url.slice(url.indexOf('#') + 1) : url.split('?')[1] ?? '';
  for (const part of source.split('&')) {
    if (!part) continue;
    const [rawKey, rawValue = ''] = part.split('=');
    try {
      params[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      // Ignore malformed query fragments; Supabase will reject missing/invalid tokens.
    }
  }
  return params;
}

async function consumeNativeAuthLink(url: string): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const params = parseLinkParams(url);
    if (params.access_token && params.refresh_token) {
      await supabase.auth.setSession({ access_token: params.access_token, refresh_token: params.refresh_token });
    } else if (params.code) {
      await supabase.auth.exchangeCodeForSession(params.code);
    }
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') console.debug('[AuthProvider] auth link rejected', error);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(initialState);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    let activeUserId: string | null = null;

    const applySession = async (session: AuthState['session'], currentGeneration: number) => {
      if (cancelled || currentGeneration !== generation) return;
      if (!session?.user) {
        activeUserId = null;
        setState((prev) => ({ ...prev, isLoading: false, session: null, user: null, profile: null, error: null }));
        return;
      }

      if (activeUserId !== null && activeUserId !== session.user.id) closeAllRealtimeChannels();
      activeUserId = session.user.id;

      setState((prev) => ({ ...prev, isLoading: false, session, user: session.user, profile: null, error: null }));
      const profile = await fetchProfile(session.user.id);
      if (cancelled || currentGeneration !== generation) return;
      setState((prev) => prev.user?.id === session.user.id ? { ...prev, profile } : prev);
    };

    const scheduleSessionApply = (session: AuthState['session']) => {
      // Defer profile I/O outside Supabase's auth callback lock.
      const currentGeneration = ++generation;
      setTimeout(() => { void applySession(session, currentGeneration); }, 0);
    };

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED' || event === 'INITIAL_SESSION') {
        scheduleSessionApply(session);
      } else if (event === 'SIGNED_OUT') {
        closeAllRealtimeChannels();
        scheduleSessionApply(null);
      }
    });

    void getCurrentSession().then(({ data: sessionData, error }) => {
      if (error && process.env.NODE_ENV !== 'production') console.debug('[AuthProvider] session restore failed');
      if (!cancelled) scheduleSessionApply(sessionData.session);
    }).catch((error: unknown) => {
      if (!cancelled) {
        if (process.env.NODE_ENV !== 'production') console.error('[AuthProvider] initialization error', error);
        setState((prev) => ({ ...prev, isLoading: false, error: mapSupabaseAuthError(error) }));
      }
    });

    const linkSubscription = Linking.addEventListener('url', ({ url }) => { void consumeNativeAuthLink(url); });
    void Linking.getInitialURL().then((url) => { if (url) return consumeNativeAuthLink(url); }).catch(() => undefined);

    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
      linkSubscription.remove();
    };
  }, []);

  const handleError = (e: unknown) => {
    setState((prev) => ({ ...prev, error: mapSupabaseAuthError(e) }));
  };

  const signUp = async (email: string, password: string, displayName: string) => {
    setState((prev) => ({ ...prev, error: null }));
    try {
      await authSignUp({ email, password, displayName });
    } catch (e) {
      handleError(e);
      throw e;
    }
  };

  const signIn = async (email: string, password: string) => {
    setState((prev) => ({ ...prev, error: null }));
    try {
      await authSignIn({ email, password });
    } catch (e) {
      handleError(e);
      throw e;
    }
  };

  const signOut = async () => {
    setState((prev) => ({ ...prev, error: null }));
    try {
      closeAllRealtimeChannels();
      await authSignOut();
    } catch (e) {
      handleError(e);
      throw e;
    }
  };

  const requestPasswordReset = async (email: string) => {
    setState((prev) => ({ ...prev, error: null }));
    try {
      await authRequestPasswordReset(email);
    } catch (e) {
      handleError(e);
      throw e;
    }
  };

  const updatePassword = async (newPassword: string) => {
    setState((prev) => ({ ...prev, error: null }));
    try {
      await authUpdatePassword(newPassword);
    } catch (e) {
      handleError(e);
      throw e;
    }
  };

  const refreshSession = async () => {
    setState((prev) => ({ ...prev, error: null }));
    try {
      await authRefreshSession();
    } catch (e) {
      handleError(e);
      throw e;
    }
  };

  const clearError = () => setState((prev) => ({ ...prev, error: null }));

  const value: AuthContextType = {
    state,
    signUp,
    signIn,
    signOut,
    requestPasswordReset,
    updatePassword,
    refreshSession,
    clearError,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}

export function useAuthState(): AuthState {
  return useAuth().state;
}

export function useSession() {
  return useAuth().state.session;
}

export function useUser() {
  return useAuth().state.user;
}

export function useProfile(): Profile | null {
  return useAuth().state.profile;
}
