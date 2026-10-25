import { createElement, useLayoutEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '@/features/auth/AuthProvider';

const f = vi.hoisted(() => ({ user: 'user-a', update: vi.fn(), put: vi.fn(), read: vi.fn(),
  commit: (_event: {userId:string;keys:string[]}) => undefined as void,
  authChanged: (_event: string, _session: unknown) => undefined as void }));
vi.mock('expo-linking', () => ({ addEventListener: () => ({ remove: vi.fn() }), getInitialURL: async () => null }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { rpc:()=>({abortSignal:()=>f.read()}), auth: {
  onAuthStateChange: (callback: typeof f.authChanged) => {
    f.authChanged = callback; return { data: { subscription: { unsubscribe: vi.fn() } } };
  },
} } }));
vi.mock('@/lib/supabase/realtime', () => ({ closeAllRealtimeChannels: vi.fn() }));
vi.mock('@/lib/local-cache/read-model-events',()=>({subscribeReadModelCommits:(callback:typeof f.commit)=>{f.commit=callback;return ()=>{};}}));
vi.mock('@/features/auth/auth-links', () => ({ parseAuthCallbackUrl: vi.fn(), stripAuthCallbackParams: vi.fn() }));
vi.mock('@/features/auth/auth', () => ({
  getCurrentSession: async () => ({ data: { session: { user: { id: f.user } } }, error: null }),
  updateMyProfile: f.update, signUp: vi.fn(), signIn: vi.fn(), signOut: vi.fn(),
  requestPasswordReset: vi.fn(), updatePassword: vi.fn(), refreshSession: vi.fn(),
}));
vi.mock('@/lib/local-cache/cache', () => ({ activeCacheUserId: async () => f.user, putCached: f.put,
  getCached:async()=>({id:f.user,display_name:'Old cache echo'}),
  SupersededReadError: class extends Error {},
  readCachedModel: async () => ({ id: f.user, display_name: `Profile ${f.user}` }),
}));

let api: ReturnType<typeof useAuth>;
let renderer: ReactTestRenderer;
function Consumer() { const value = useAuth(); useLayoutEffect(() => { api = value; }, [value]); return null; }
beforeEach(async () => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  f.user = 'user-a'; f.update.mockReset(); f.put.mockReset(); f.read.mockReset();
  await act(async () => { renderer = create(createElement(AuthProvider, null, createElement(Consumer))); });
  await act(async () => { await vi.runAllTimersAsync(); });
});
afterEach(async () => {
  await act(async () => { renderer.unmount(); });
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
describe('profile mutation cache isolation', () => {
  it('never writes the previous account profile into a newly signed-in account', async () => {
    let finish!: (value: { id: string; display_name: string }) => void;
    f.update.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    let pending!: Promise<void>;
    await act(async () => { pending = api.updateProfile('Changed A', 'Profile user-a'); });
    expect(f.update).toHaveBeenCalledWith('Changed A', 'Profile user-a');
    f.user = 'user-b';
    await act(async () => { f.authChanged('SIGNED_IN', { user: { id: f.user } }); await vi.runAllTimersAsync(); });
    const stale = expect(pending).rejects.toThrow('Сеанс или профиль изменился.');
    await act(async () => { finish({ id: 'user-a', display_name: 'Changed A' }); await stale; });
    expect(f.put).not.toHaveBeenCalled();
    expect(api.state).toMatchObject({ user: { id: 'user-b' }, profile: { id: 'user-b', display_name: 'Profile user-b' } });
  });
  it('updates the current account profile and its own snapshot normally', async () => {
    const profile = { id: 'user-a', display_name: 'Changed A' };
    f.update.mockResolvedValue(profile);
    await act(async () => { await api.updateProfile('Changed A', 'Profile user-a'); });
    expect(f.put).toHaveBeenCalledWith('user-a', 'profile:self', profile, expect.any(AbortSignal));
    expect(api.state.profile).toMatchObject(profile);
  });
  it('rejects a delayed authoritative read after A -> B -> A', async () => {
    let finish!: (result: unknown) => void;
    f.read.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    let pending!:Promise<unknown>;
    await act(async()=>{pending=api.refreshProfile();});
    const stale=expect(pending).rejects.toThrow('Сеанс или профиль изменился.');
    for(const id of ['user-b','user-a']){f.user=id;await act(async()=>{f.authChanged('SIGNED_IN',{user:{id}});await vi.advanceTimersByTimeAsync(0);});}
    await act(async()=>{finish({data:{id:'user-a',display_name:'Obsolete'},error:null});await stale;});
    expect(f.put).not.toHaveBeenCalled();expect(api.state.profile?.display_name).toBe('Profile user-a');
  });
  it('an unsuccessful authoritative refresh keeps the current profile',async()=>{
    f.read.mockResolvedValue({data:null,error:{code:'42501',message:'Denied'}});
    await act(async()=>{await expect(api.refreshProfile()).rejects.toMatchObject({code:'42501'});});
    expect(api.state.profile?.display_name).toBe('Profile user-a');expect(f.put).not.toHaveBeenCalled();
  });
  it('a same-account session refresh or cache echo cannot discard an explicit save result',async()=>{
    let finish!:(profile:unknown)=>void;f.update.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));let pending!:Promise<void>;
    await act(async()=>{pending=api.updateProfile('Committed result','Profile user-a');});
    await act(async()=>{f.authChanged('TOKEN_REFRESHED',{user:{id:'user-a'}});f.commit({userId:'user-a',keys:['profile:self']});await vi.advanceTimersByTimeAsync(0);});
    await act(async()=>{finish({id:'user-a',display_name:'Committed result'});await pending;});
    expect(api.state.profile?.display_name).toBe('Committed result');expect(f.put).toHaveBeenCalledOnce();
  });
});
