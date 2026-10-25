import { createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import NotificationsScreen from '@/app/(app)/notifications';
const f=vi.hoisted(()=>({rows:[{id:'old',is_read:false,created_at:'2026-10-22',title:'Old',body:'',type:'task_assigned'}],
  load:null as null|(()=>Promise<unknown>),lose:true,gate:null as null|Promise<void>,fetches:[] as unknown[][]}));
vi.mock('react-native',()=>({View:'View',ScrollView:'ScrollView',Pressable:'Pressable',RefreshControl:'RefreshControl',StyleSheet:{create:(s:unknown)=>s}}));
vi.mock('expo-router',()=>({router:{push:vi.fn()},useFocusEffect:vi.fn()}));
vi.mock('@/features/auth/AuthProvider',()=>({useUser:()=>({id:'user'})}));
vi.mock('@/lib/connectivity/use-online-recovery',()=>({useOnlineRecovery:vi.fn()}));
vi.mock('@/lib/local-cache/cache',()=>({isExplicitAccessError:()=>false}));
vi.mock('@/lib/local-cache/use-read-model-updates',()=>({useReadModelUpdates:(load:()=>Promise<unknown>)=>{f.load=load;return {scheduleRefresh:()=>{void load();},refreshFromServer:load};}}));
vi.mock('@/features/notifications/notifications',()=>({fetchNotificationPage:async(...args:unknown[])=>{f.fetches.push(args);return {rows:f.rows.map(r=>({...r})),offline:false,hasMore:false};},
  fetchNotificationFilterOptions:async()=>({projects:[],tasks:[]}),subscribeToNotifications:()=>()=>{},notificationBody:()=>'',notificationRoute:()=>null,stageNotificationText:(s:string)=>s,
  markAsRead:vi.fn(),markAllAsRead:async()=>{if(f.gate)await f.gate;if(f.lose){f.lose=false;f.rows[0].is_read=true;throw Error('Lost response');} /* replay: no new business effect */}}));
vi.mock('@/features/notifications/notification-filters',()=>({NotificationFilters:'Filters'}));
vi.mock('@/components/ui/theme-provider',()=>({useTheme:()=>({colors:{}})}));
vi.mock('@/components/ui/screen',()=>({Screen:'Screen'}));
vi.mock('@/components/ui/page-header',()=>({PageHeader:({actions}:{actions:ReactNode})=>actions}));
vi.mock('@/components/ui/card',()=>({Card:'Card'}));
vi.mock('@/components/ui/badge',()=>({Badge:'Badge'}));
vi.mock('@/components/ui/button',()=>({Button:'Button'}));
vi.mock('@/components/ui/text',()=>({ThemedText:'Text'}));
vi.mock('@/components/ui/error-message',()=>({ErrorMessage:'ErrorMessage'}));
vi.mock('@/components/ui/states',()=>({EmptyState:'EmptyState',ErrorState:'ErrorState',LoadingState:'LoadingState'}));
let screen:ReactTestRenderer;
beforeEach(()=>{f.rows=[{id:'old',is_read:false,created_at:'2026-10-22',title:'Old',body:'',type:'task_assigned'}];f.lose=true;f.gate=null;f.fetches=[];});
afterEach(async()=>{await act(async()=>screen?.unmount());vi.unstubAllGlobals();});
it('B02 real screen does not confirm a new notice from a replayed bulk receipt',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  await act(async()=>{screen=create(createElement(NotificationsScreen));});
  await act(async()=>{await f.load!();});
  const all=()=>screen.root.findAllByType('Button' as never).find(n=>n.props.children==='Прочитать все')!;
  await act(async()=>all().props.onPress());
  f.rows.unshift({id:'new',is_read:false,created_at:'2026-10-23',title:'New',body:'',type:'task_assigned'});
  await act(async()=>{await f.load!();});
  await act(async()=>all().props.onPress());
  await act(async()=>{await f.load!();});
  expect(f.rows[0].is_read).toBe(false);
  expect(screen.root.findAllByType('Button' as never).filter(n=>n.props.children==='Отметить прочитанным')).toHaveLength(1);
});
it('B02 authoritative refresh uses filters changed while the bulk RPC was in flight',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);f.lose=false;let release!:()=>void;f.gate=new Promise(resolve=>{release=resolve;});
  await act(async()=>{screen=create(createElement(NotificationsScreen));});await act(async()=>{await f.load!();});
  await act(async()=>{screen.root.findAllByType('Button' as never).find(n=>n.props.children==='Прочитать все')!.props.onPress();});
  await act(async()=>{screen.root.findByType('Filters' as never).props.onApply({reads:['unread']});});
  await act(async()=>{release();await f.gate;});
  expect(f.fetches.at(-1)?.slice(2)).toEqual([{reads:['unread']},{requireServer:true}]);
});
