import React, { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import * as Linking from 'expo-linking';
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
import { parseAuthCallbackUrl, stripAuthCallbackParams } from './auth-links';

type AuthContextType = {
  state: AuthState;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
  refreshSession: () => Promise<void>;
  updateProfile: (displayName: string) => Promise<void>;
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

async function fetchProfile(): Promise<Profile | null> {
  try {
    const { data, error } = await supabase.rpc('get_my_profile');
    if (error) {
      if (process.env.NODE_ENV !== 'production') console.debug('[AuthProvider] profile fetch error:', error.message);
      return null;
    }
    return data as Profile;
  } catch {
    if (process.env.NODE_ENV !== 'production') console.debug('[AuthProvider] profile fetch exception');
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(initialState);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    let activeUserId: string | null = null;
    const handledAuthLinks = new Set<string>();

    const consumeAuthLink = async (url: string): Promise<void> => {
      const callback = parseAuthCallbackUrl(url);
      if (!callback || handledAuthLinks.has(url)) return;
      handledAuthLinks.add(url);
      try {
        const { error } = await supabase.auth.exchangeCodeForSession(callback.code, { flowId: callback.flowId });
        if (error) throw error;
        if (typeof window !== 'undefined' && window.location.href === url) {
          window.history.replaceState(null, '', stripAuthCallbackParams(url));
        }
      } catch (error) {
        handledAuthLinks.delete(url);
        if (process.env.NODE_ENV !== 'production') console.debug('[AuthProvider] auth callback rejected', error);
        if (!cancelled) setState((prev) => ({ ...prev, isLoading: false, error: mapSupabaseAuthError(error) }));
      }
    };

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
      const profile = await fetchProfile();
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

    const linkSubscription = Linking.addEventListener('url', ({ url }) => { void consumeAuthLink(url); });
    void Linking.getInitialURL().then((url) => { if (url) return consumeAuthLink(url); }).catch(() => undefined);
    if (typeof window !== 'undefined') void consumeAuthLink(window.location.href);

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

  const updateProfile = async (displayName: string) => {
    const { updateMyProfile } = await import('./auth');
    const profile = await updateMyProfile(displayName);
    setState((prev) => ({ ...prev, profile: profile as unknown as Profile }));
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
    updateProfile,
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
