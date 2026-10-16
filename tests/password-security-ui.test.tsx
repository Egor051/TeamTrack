import { createElement } from 'react';
import { act,create,type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach,afterEach,it,expect,vi } from 'vitest';
const f=vi.hoisted(()=>({user:'user-a',signIn:vi.fn(),update:vi.fn(),
 changed:(_event:string,_session:unknown)=>undefined as void}));
vi.mock('expo-linking',()=>({addEventListener:()=>({remove:vi.fn()}),getInitialURL:async()=>null}));
vi.mock('expo-router',()=>({Link:'Link'}));
vi.mock('react-native',()=>({View:'View',StyleSheet:{create:(v:unknown)=>v}}));
vi.mock('@/components/ui/button',()=>({Button:'Button'}));
vi.mock('@/components/ui/error-message',()=>({ErrorMessage:'Message'}));
vi.mock('@/lib/supabase/client',()=>({supabase:{auth:{onAuthStateChange:(callback:typeof f.changed)=>{
 f.changed=callback;return{data:{subscription:{unsubscribe:vi.fn()}}};}}}}));
vi.mock('@/lib/supabase/realtime',()=>({closeAllRealtimeChannels:vi.fn()}));
vi.mock('@/features/auth/auth-links',()=>({parseAuthCallbackUrl:vi.fn(),stripAuthCallbackParams:vi.fn()}));
vi.mock('@/features/auth/auth',()=>({
 getCurrentSession:async()=>({data:{session:{user:{id:f.user}}},error:null}),signIn:f.signIn,updatePassword:f.update,
 signUp:vi.fn(),signOut:vi.fn(),requestPasswordReset:vi.fn(),refreshSession:vi.fn(),resendConfirmation:vi.fn(),
}));
vi.mock('@/lib/local-cache/cache',()=>({activeCacheUserId:async()=>f.user,
 readCachedModel:async()=>({id:f.user,display_name:'User'}),getCached:vi.fn(),
}));
import {AuthProvider,useAuth} from '@/features/auth/AuthProvider';
import {PasswordSecurityNotice} from '@/features/auth/components/password-security-notice';
let api:ReturnType<typeof useAuth>,renderer:ReactTestRenderer;
function Consumer(){api=useAuth();return createElement(PasswordSecurityNotice);}
const session=(id=f.user)=>({user:{id}});
const response=(warning=true)=>({user:{id:f.user},session:session(),...(warning?{weakPassword:{reasons:['pwned']}}:{})});
beforeEach(async()=>{
 vi.useFakeTimers();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 vi.spyOn(console,'error').mockImplementation(()=>undefined);
 f.user='user-a';f.signIn.mockReset();f.update.mockReset();
 f.signIn.mockImplementation(async()=>{f.changed('SIGNED_IN',session());return response();});
 await act(async()=>{renderer=create(createElement(AuthProvider,{children:createElement(Consumer)}));});
 await act(async()=>{await vi.runAllTimersAsync();});
});
afterEach(async()=>{await act(async()=>renderer.unmount());vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function login(){await act(async()=>{await api.signIn('a@example.test','password');await vi.runAllTimersAsync();});}
it('keeps a successful session and shows its warning with a password-change route',async()=>{
 await login();expect(api.state.session?.user.id).toBe('user-a');expect(api.state.error).toBeNull();
 expect(api.passwordWarning).toContain('утечках');
 expect(renderer.root.findByType('Message' as never).props.message).toContain('утечках');
 expect(renderer.root.findByType('Link' as never).props.href).toBe('/reset-password');
});
it('does not invent a warning when Auth did not return one',async()=>{
 f.signIn.mockImplementation(async()=>response(false));await login();expect(api.passwordWarning).toBeNull();
});
it('keeps a weak-password rejection as a form error',async()=>{
 f.signIn.mockRejectedValue({code:'weak_password',reasons:['pwned']});
 await act(async()=>{await expect(api.signIn('a@example.test','bad')).rejects.toMatchObject({code:'weak_password'});});
 expect(api.state.error).toContain('утечках');expect(api.passwordWarning).toBeNull();
});
it('clears the notice after successful password change',async()=>{
 await login();await act(async()=>{await api.updatePassword('NewStrong123');});expect(api.passwordWarning).toBeNull();
});
it('retains the notice and displays server reasons if password change fails',async()=>{
 await login();f.update.mockRejectedValue({code:'weak_password',reasons:['pwned']});
 await act(async()=>{await expect(api.updatePassword('BadAgain1')).rejects.toMatchObject({code:'weak_password'});});
 expect(api.passwordWarning).toContain('утечках');expect(api.state.error).toContain('утечках');
});
it('does not carry the notice into a different account',async()=>{
 await login();f.user='user-b';
 await act(async()=>{f.changed('SIGNED_IN',session());await vi.runAllTimersAsync();});
 expect(api.state.user?.id).toBe('user-b');expect(api.passwordWarning).toBeNull();
});
it('fences late sign-in warnings across sign-out and a new session of the same account',async()=>{
 let finish!:(v:ReturnType<typeof response>)=>void;let pending!:Promise<void>;
 f.signIn.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 await act(async()=>{pending=api.signIn('a@example.test','password');});
 await act(async()=>{f.changed('SIGNED_OUT',null);f.changed('SIGNED_IN',session());await vi.runAllTimersAsync();});
 await act(async()=>{finish(response());await pending;});expect(api.passwordWarning).toBeNull();
});
