import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import TemplatesScreen from '@/app/(app)/templates';

const f=vi.hoisted(()=>({user:'owner',identity:vi.fn(),list:vi.fn(),subscribe:vi.fn(),recover:null as null|(()=>Promise<void>)}));
vi.mock('react-native',()=>({View:'View',ScrollView:'ScrollView',Pressable:'Pressable',StyleSheet:{create:(value:unknown)=>value}}));
vi.mock('expo-router',async()=>{const React=await import('react');return{useFocusEffect:(callback:()=>void)=>React.useEffect(callback,[callback])};});
vi.mock('@/lib/connectivity/use-online-recovery',()=>({useOnlineRecovery:(load:()=>Promise<void>)=>{f.recover=load;}}));
vi.mock('@/features/auth/auth',()=>({getCurrentUser:f.identity}));
vi.mock('@/lib/local-cache/cache',()=>({activeCacheUserId:async()=>f.user}));
vi.mock('@/lib/local-cache/read-freshness',()=>({isReadAccessPending:()=>false,invalidateReadModels:async()=>undefined,scopeReadPrefixes:async()=>['templates','template:','template-items:']}));
vi.mock('@/lib/supabase/realtime',()=>({subscribeMany:f.subscribe}));
vi.mock('@/features/projects/projects',()=>({listTaskTemplates:f.list,listTaskTemplateItems:async()=>[],createTaskTemplate:vi.fn(),createTaskTemplateItem:vi.fn(),deleteTaskTemplate:vi.fn(),deleteTaskTemplateItem:vi.fn(),updateTaskTemplate:vi.fn(),updateTaskTemplateItem:vi.fn(),moveTaskTemplateItem:vi.fn()}));
vi.mock('@/components/ui/screen',()=>({Screen:'Screen'}));
vi.mock('@/components/ui/page-header',()=>({PageHeader:'PageHeader'}));
vi.mock('@/components/ui/card',()=>({Card:'Card'}));
vi.mock('@/components/ui/button',()=>({Button:'Button'}));
vi.mock('@/components/ui/input',()=>({Input:'Input'}));
vi.mock('@/components/ui/textarea',()=>({Textarea:'Textarea'}));
vi.mock('@/components/ui/states',()=>({EmptyState:'EmptyState',LoadingState:'LoadingState'}));
vi.mock('@/components/ui/error-message',()=>({ErrorMessage:'ErrorMessage'}));
vi.mock('@/components/ui/text',()=>({ThemedText:'ThemedText'}));
vi.mock('@/components/ui/confirm-dialog',()=>({ConfirmDialog:'ConfirmDialog'}));

const renderers:ReactTestRenderer[]=[],settlers:(()=>void)[]=[];
const row=(createdBy='owner')=>({id:'template-1',name:'Dialog template',description:'',created_by:createdBy,item_count:0});
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((ok,no)=>{resolve=ok;reject=no;});return{promise,resolve,reject};}
async function render(){let screen!:ReactTestRenderer;await act(async()=>{screen=create(createElement(TemplatesScreen));});renderers.push(screen);return screen;}
const expander=(screen:ReactTestRenderer)=>screen.root.findAllByProps({accessibilityLabel:'Раскрыть шаблон Dialog template'});
beforeEach(()=>{
 vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.spyOn(console,'error').mockImplementation(()=>undefined);
 f.user='owner';f.identity.mockReset().mockImplementation(async()=>({data:{user:{id:f.user}},error:null}));f.list.mockReset().mockResolvedValue([row()]);f.subscribe.mockReset().mockReturnValue(()=>undefined);f.recover=null;
});
afterEach(async()=>{await act(async()=>{renderers.splice(0).forEach(screen=>screen.unmount());settlers.splice(0).forEach(settle=>settle());});vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});

it('P04 subscribes before the first list settles, so the existing reconnect scheduler recovers a fenced initial read',async()=>{
 const first=deferred<ReturnType<typeof row>[]>();settlers.push(()=>first.resolve([]));f.list.mockReturnValueOnce(first.promise);
 const screen=await render();
 expect(f.list).toHaveBeenCalledTimes(1);
 expect(f.subscribe).toHaveBeenCalledTimes(1);
 const onStatus=f.subscribe.mock.calls[0][0][0].options.onStatus as (status:string)=>void;
 await act(async()=>{first.reject(Object.assign(new Error('Сеанс или доступ изменился во время загрузки.'),{name:'SupersededReadError'}));onStatus('connected');await vi.advanceTimersByTimeAsync(150);});
 expect(f.list).toHaveBeenCalledTimes(2);expect(expander(screen)).toHaveLength(1);
 expect(screen.root.findAllByType('ErrorMessage' as never)).toHaveLength(0);
});

it('P04 preserves a real read denial and never substitutes a cached template or a successful load',async()=>{
 f.list.mockRejectedValue({status:403,code:'42501',message:'Access denied'});
 const screen=await render();await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
 expect(f.list).toHaveBeenCalledTimes(1);expect(expander(screen)).toHaveLength(0);
 expect(screen.root.findByType('ErrorMessage' as never).props.message).toContain('Доступ запрещён');
});

it('P04 keeps another owner template read-only after subscribing early',async()=>{
 f.user='viewer';const screen=await render();await act(async()=>{expander(screen)[0].props.onPress();});
 expect(JSON.stringify(screen.toJSON())).toContain('Только просмотр');
 expect(screen.root.findAllByType('Button' as never).filter(button=>button.props.children==='Удалить')).toHaveLength(0);
});

it('P04 rejects a late identity from a superseded account read before starting its template query',async()=>{
 const first=deferred<{data:{user:{id:string}},error:null}>();settlers.push(()=>first.resolve({data:{user:{id:'owner'}},error:null}));f.identity.mockReturnValueOnce(first.promise);
 const screen=await render();f.user='next-owner';f.list.mockResolvedValue([row('next-owner')]);
 await act(async()=>{await f.recover!();});
 await act(async()=>{first.resolve({data:{user:{id:'owner'}},error:null});});
 expect(f.list).toHaveBeenCalledTimes(1);expect(expander(screen)).toHaveLength(1);
 await act(async()=>{expander(screen)[0].props.onPress();});
 expect(JSON.stringify(screen.toJSON())).toContain('Можно редактировать');
});
