import React, { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import * as Linking from 'expo-linking';
import { supabase, probeSupabaseConnectivity } from '@/lib/supabase/client';
import { monitorConnectivity, subscribeConnectivity, usesLocalReads } from '@/lib/connectivity/state';
import type { Profile } from '@/lib/supabase/client';
import type { AuthState } from './types';
import { mapSupabaseAuthError, weakPasswordMessage } from '@/lib/errors/auth-errors';
import {
  signUp as authSignUp,
  signIn as authSignIn,
  signOut as authSignOut,
  requestPasswordReset as authRequestPasswordReset,
  resendConfirmation as authResendConfirmation,
  updatePassword as authUpdatePassword,
  refreshSession as authRefreshSession,
  getCurrentSession,
} from './auth';
import { closeAllRealtimeChannels } from '@/lib/supabase/realtime';
import { parseAuthCallbackUrl, stripAuthCallbackParams } from './auth-links';
import { readCachedModel as readThroughCache, activeCacheUserId, getCached, putCached, SupersededReadError } from '@/lib/local-cache/cache';
import { subscribeReadModelCommits } from '@/lib/local-cache/read-model-events';
import { clearRuntimeConfig } from '@/lib/local-cache/runtime-config';
import { uiRead } from '@/lib/supabase/ui-read';
import { invalidateOfflineRuntime } from '@/lib/local-cache/runtime-state';
import { clearReadFreshness, currentReadAccount, setReadAccount, readAccountEpoch } from '@/lib/local-cache/read-freshness';
import { ConnectivityUnavailableError } from '@/lib/connectivity/errors';
import type { MutationOptions } from '@/lib/supabase/mutation';

type AuthContextType = {
  state: AuthState;
  passwordWarning: string | null;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  resendConfirmation: (email: string) => Promise<void>;
  updatePassword: (newPassword: string) => Promise<void>;
  refreshSession: () => Promise<void>;
  updateProfile: (displayName: string, expectedDisplayName: string, options?: MutationOptions) => Promise<void>;
  refreshProfile: () => Promise<Profile>;
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
    return await readThroughCache('profile:self', async () => {
      const { data, error } = await uiRead(supabase.rpc('get_my_profile'));
      if (error) throw error;
      return data as Profile;
    });
  } catch {
    if (process.env.NODE_ENV !== 'production') console.debug('[AuthProvider] profile fetch exception');
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(initialState);
  const [passwordNotice, setPasswordNotice] = useState<{ userId: string; message: string } | null>(null);
  const authAttempt = useRef(0);
  const profileGeneration = useRef(0);
  const profileController = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    let activeUserId: string | null = null;
    let runtimeUserId: string | null = null;
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

      activeUserId = session.user.id;

      setState((prev) => ({ ...prev, isLoading: false, session, user: session.user,
        profile: prev.user?.id === session.user.id ? prev.profile : null, error: null }));
      if (profileController.current && !profileController.current.signal.aborted) return;
      const profileRequest = ++profileGeneration.current;
      const profile = await fetchProfile();
      if (cancelled || currentGeneration !== generation || profileRequest !== profileGeneration.current) return;
      setState((prev) => prev.user?.id === session.user.id ? { ...prev, profile } : prev);
    };

    const scheduleSessionApply = (session: AuthState['session']) => {
      if (cancelled) return;
      const nextUserId = session?.user?.id ?? null;
      if (nextUserId !== currentReadAccount() || !nextUserId) {
        profileGeneration.current += 1; profileController.current?.abort();
      }
      setPasswordNotice((previous) => previous?.userId === nextUserId ? previous : null);
      // Fence callbacks synchronously, before publishing a different namespace.
      if (nextUserId !== currentReadAccount()) closeAllRealtimeChannels();
      setReadAccount(nextUserId);
      if (nextUserId !== runtimeUserId) clearReadFreshness();
      if (runtimeUserId && nextUserId !== runtimeUserId) invalidateOfflineRuntime(runtimeUserId);
      if (nextUserId !== runtimeUserId || !nextUserId) clearRuntimeConfig();
      runtimeUserId = nextUserId;
      // Defer profile I/O outside Supabase's auth callback lock.
      const currentGeneration = ++generation;
      setTimeout(() => { void applySession(session, currentGeneration); }, 0);
    };

    const restoreSession = async () => {
      const startedGeneration = generation;
      const { data } = await getCurrentSession();
      if (!cancelled && generation === startedGeneration) scheduleSessionApply(data.session);
    };

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION' && !session && usesLocalReads()) {
        void restoreSession().catch(() => undefined);
        return;
      }
      if (event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED' || event === 'INITIAL_SESSION') {
        scheduleSessionApply(session);
      } else if (event === 'SIGNED_OUT') {
        authAttempt.current += 1;
        closeAllRealtimeChannels();
        scheduleSessionApply(null);
      }
    });

    const monitoring = monitorConnectivity((signal) => probeSupabaseConnectivity(signal));
    const connectivity = subscribeConnectivity((next) => {
      if (next !== 'online') return;
      void restoreSession().catch(() => undefined);
    });
    const models = subscribeReadModelCommits((commit) => {
      if (!activeUserId || commit.userId !== activeUserId || !commit.keys.includes('profile:self')) return;
      // A background cache echo must not supersede an explicit server read/save.
      if (profileController.current && !profileController.current.signal.aborted) return;
      const currentGeneration = generation;
      const profileRequest = ++profileGeneration.current;
      void getCached<Profile>(commit.userId, 'profile:self').then((profile) => {
        if (!cancelled && generation === currentGeneration && profileRequest === profileGeneration.current)
          setState((prev) => prev.user?.id === commit.userId ? { ...prev, profile } : prev);
      });
    });
    const storageChanged = () => {
      if (!usesLocalReads()) return;
      void restoreSession().catch(() => undefined);
    };
    if (typeof window !== 'undefined') window.addEventListener('storage', storageChanged);

    const initialGeneration = generation;
    void getCurrentSession().then(({ data: sessionData, error }) => {
      if (error && process.env.NODE_ENV !== 'production') console.debug('[AuthProvider] session restore failed');
      if (!cancelled && generation === initialGeneration) scheduleSessionApply(sessionData.session);
    }).catch((error: unknown) => {
      if (!cancelled && generation === initialGeneration) {
        if (process.env.NODE_ENV !== 'production') console.error('[AuthProvider] initialization error', error);
        setState((prev) => ({ ...prev, isLoading: false, error: mapSupabaseAuthError(error) }));
      }
    });

    const linkSubscription = Linking.addEventListener('url', ({ url }) => { void consumeAuthLink(url); });
    void Linking.getInitialURL().then((url) => { if (url) return consumeAuthLink(url); }).catch(() => undefined);
    if (typeof window !== 'undefined') void consumeAuthLink(window.location.href);

    return () => {
      cancelled = true;
      profileGeneration.current += 1; profileController.current?.abort();
      clearRuntimeConfig();
      connectivity(); monitoring(); models();
      if (typeof window !== 'undefined') window.removeEventListener('storage', storageChanged);
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
    const attempt = ++authAttempt.current;
    setPasswordNotice(null);
    setState((prev) => ({ ...prev, error: null }));
    try {
      const data = await authSignIn({ email, password });
      if (attempt === authAttempt.current && data?.user?.id === currentReadAccount() && data.weakPassword) {
        setPasswordNotice({ userId: data.user.id, message: weakPasswordMessage(data.weakPassword) });
      }
    } catch (e) {
      handleError(e);
      throw e;
    }
  };

  const signOut = async () => {
    authAttempt.current += 1;
    setState((prev) => ({ ...prev, error: null }));
    try {
      closeAllRealtimeChannels();
      await authSignOut();
      setReadAccount(null);
      clearReadFreshness();
      clearRuntimeConfig();
      setPasswordNotice(null);
      setState((prev) => ({ ...prev, isLoading: false, session: null, user: null, profile: null, error: null }));
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
    const userId = state.user?.id;
    const attempt = ++authAttempt.current;
    setState((prev) => ({ ...prev, error: null }));
    try {
      await authUpdatePassword(newPassword);
      if (attempt === authAttempt.current && userId && currentReadAccount() === userId) setPasswordNotice((previous) => previous?.userId === userId ? null : previous);
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

  const resendConfirmation = async (email: string) => {
    setState((prev) => ({ ...prev, error: null }));
    try {
      await authResendConfirmation(email);
    } catch (e) {
      handleError(e);
      throw e;
    }
  };

  const updateProfile = async (displayName: string, expectedDisplayName: string, options?: MutationOptions) => {
    const userId = state.user?.id;
    const epoch = readAccountEpoch(); const request = ++profileGeneration.current;
    profileController.current?.abort(); const controller = new AbortController(); profileController.current = controller;
    const current = async () => {
      const owner = await activeCacheUserId();
      return !controller.signal.aborted && epoch === readAccountEpoch() && request === profileGeneration.current && owner === userId;
    };
    try {
      const { updateMyProfile } = await import('./auth');
      if (!userId || !await current() || controller.signal.aborted || epoch !== readAccountEpoch()) throw new SupersededReadError('Сеанс или профиль изменился.');
      const profile = (options ? await updateMyProfile(displayName, expectedDisplayName, options)
        : await updateMyProfile(displayName, expectedDisplayName)) as unknown as Profile;
      if (profile?.id !== userId || !await current()) throw new SupersededReadError('Сеанс или профиль изменился.');
      await putCached(userId, 'profile:self', profile, controller.signal);
      if (!await current()) throw new SupersededReadError('Сеанс или профиль изменился.');
      setState((prev) => prev.user?.id === userId && epoch === readAccountEpoch() && !controller.signal.aborted ? { ...prev, profile } : prev);
    } finally { if (profileController.current === controller) profileController.current = null; }
  };

  const refreshProfile = async (): Promise<Profile> => {
    if (usesLocalReads()) throw new ConnectivityUnavailableError();
    const userId = state.user?.id; const epoch = readAccountEpoch(); const request = ++profileGeneration.current;
    profileController.current?.abort(); const controller = new AbortController(); profileController.current = controller;
    const current = async () => {
      const owner = await activeCacheUserId();
      return !!userId && !controller.signal.aborted && epoch === readAccountEpoch() && request === profileGeneration.current && owner === userId;
    };
    try {
      if (!await current()) throw new SupersededReadError('Сеанс изменился.');
      const { data, error } = await uiRead(supabase.rpc('get_my_profile'), controller.signal).catch((error) => {
        if (controller.signal.aborted || epoch !== readAccountEpoch() || request !== profileGeneration.current)
          throw new SupersededReadError('Сеанс или профиль изменился.');
        throw error;
      });
      if (error) throw error;
      const profile = data as Profile;
      if (profile?.id !== userId || !await current()) throw new SupersededReadError('Сеанс или профиль изменился.');
      await putCached(userId!, 'profile:self', profile, controller.signal);
      if (!await current()) throw new SupersededReadError('Сеанс или профиль изменился.');
      setState(prev => prev.user?.id === userId && epoch === readAccountEpoch() && !controller.signal.aborted ? { ...prev, profile } : prev);
      return profile;
    } finally { if (profileController.current === controller) profileController.current = null; }
  };

  const clearError = () => setState((prev) => ({ ...prev, error: null }));

  const value: AuthContextType = {
    state,
    passwordWarning: passwordNotice && passwordNotice.userId === state.user?.id ? passwordNotice.message : null,
    signUp,
    signIn,
    signOut,
    requestPasswordReset,
    resendConfirmation,
    updatePassword,
    refreshSession,
    updateProfile,
    refreshProfile,
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
