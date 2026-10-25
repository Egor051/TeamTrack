import { beforeEach, expect, it, vi } from 'vitest';
import { ChecklistLocalRepository } from '@/lib/local-cache/repository';
import { listTaskItems } from '@/features/projects/projects';
const f=vi.hoisted(()=>({calls:0,sync:true,rows:Array.from({length:501},(_,i)=>({id:String(i+1),position:i,task_id:'task',is_archived:false})),revision:1}));
vi.mock('@/features/auth/auth',()=>({getCurrentUser:vi.fn()}));
vi.mock('@/lib/local-cache/runtime-config',()=>({buildSyncEnabled:()=>f.sync}));
vi.mock('@/lib/supabase/client',()=>({supabase:{
  from:()=>{let offset=0; const q={select:()=>q,eq:()=>q,order:()=>q,range:(a:number)=>{offset=a;return q;},maybeSingle:async()=>({data:{id:'task'},error:null}),then:(ok:(v:unknown)=>unknown)=>{
    const rows=f.rows.slice(offset,offset+500); if(++f.calls===1){f.rows=f.rows.slice(1);f.revision++;} return Promise.resolve({data:rows,error:null}).then(ok);
  }}; return q;},
  rpc:(_name:string,args:{p_offset:number;p_revision?:number})=>{const revision=f.revision; const rows=f.rows.slice(args.p_offset,args.p_offset+500); const total=f.rows.length;
    const result=args.p_revision!==undefined&&args.p_revision!==revision?{data:null,error:{code:'PT409'}}:{data:{revision,total,offset:args.p_offset,rows},error:null};
    if(++f.calls===1){f.rows=f.rows.slice(1);f.revision++;} return Promise.resolve(result);
  }
}}));
vi.mock('@/lib/local-cache/cache',()=>({activeCacheUserId:async()=>'user',getCached:async()=>null,
  readCachedModel:async(_k:string,read:()=>Promise<unknown>)=>read(),inheritCachedResult:(_s:unknown,v:unknown)=>v,
  SupersededReadError:class extends Error{},isTaskProjectBlocked:async()=>false}));
vi.mock('@/lib/local-cache/driver',()=>({localCacheDriver:{get:async()=>null}}));
vi.mock('@/lib/local-cache/outbox',()=>({applyPendingOperations:(v:unknown)=>v,listPendingOperations:async()=>[]}));
vi.mock('@/lib/local-cache/sync',()=>({announceSyncChange:vi.fn(),subscribeSyncChanges:vi.fn()}));
vi.mock('@/lib/local-cache/status',()=>({getSyncState:vi.fn(),subscribeSyncState:vi.fn()}));
vi.mock('@/lib/local-cache/edit',()=>({performSupportedEdit:vi.fn()}));
vi.mock('@/lib/connectivity/state',()=>({usesLocalReads:()=>false}));
vi.mock('@/lib/supabase/ui-read',()=>({uiRead:async(v:unknown)=>await v}));
vi.mock('@/lib/local-cache/read-freshness',()=>({readAccountEpoch:()=>1,readInvalidation:()=>({kind:null}),durableReadInvalidation:async()=>({kind:null})}));
beforeEach(()=>{f.calls=0;f.sync=true;f.revision=1;f.rows=Array.from({length:501},(_,i)=>({id:String(i+1),position:i,task_id:'task',is_archived:false}));});
it('B03 actual UI repository discards pages after a concurrent archive',async()=>{
  const rows=await ChecklistLocalRepository.refreshTaskItems('user','task','active');
  expect(rows.map(r=>r.id)).toEqual(f.rows.map(r=>r.id)); expect(rows.at(-1)?.id).toBe('501');
});
it.each([true,false])('B03 public listTaskItems uses snapshots with sync=%s',async sync=>{
  f.sync=sync;
  const rows=await listTaskItems('00000000-0000-4000-8000-000000000001');
  expect(rows.map(r=>r.id)).toEqual(f.rows.map(r=>r.id));expect(rows.at(-1)?.id).toBe('501');
});
