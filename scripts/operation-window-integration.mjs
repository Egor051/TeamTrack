// Real isolated PostgreSQL/PostgREST protocol acceptance. No linked/hosted DB.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync,readFileSync,readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSecurityDatabase,asUser,connect } from './security-test-harness.mjs';
import { startSecurityApi } from './security-test-api.mjs';
import { receiptTestPolicySql } from './receipt-test-policy.mjs';
const dir=resolve('.expo','operation-window',Date.now()+'-'+process.pid);mkdirSync(dir,{recursive:true});
const evidence=[];const upgrade=process.argv.includes('--upgrade');
const env=await createSecurityDatabase({beforeVersion:upgrade?'20261023115036':null});let api;
const check=async(name,test)=>{const started=performance.now();try{await test();evidence.push({name,result:'PASS',ms:performance.now()-started});console.log('PASS '+name);}catch(e){evidence.push({name,result:'FAIL',error:e.message});throw e;}};
const value=async query=>{const r=await query;if(r.error)throw Object.assign(new Error(r.error.message),r.error);return r.data;};
try{
 if(process.argv.includes('--types')){
  const r=spawnSync(process.execPath,['scripts/gen-types.mjs'],{encoding:'utf8',env:{...process.env,SUPABASE_DB_URL:'postgresql://supabase_admin:postgres@127.0.0.1:'+env.port+'/'+env.database},windowsHide:true});
  writeFileSync(resolve(dir,'types.log'),r.stdout+r.stderr);if(r.status!==0)throw Error(r.stdout+r.stderr);console.log(r.stdout);
 }else{
 api=await startSecurityApi(env);const u=randomUUID(),other=randomUUID();
 await env.db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}'),($3,$4,'{}')",[u,u+'@window.test',other,other+'@window.test']);
 const client=api.client(u),legacyId=randomUUID(),legacyArgs={p_name:'Legacy preserved'};
 const legacy=()=>client.rpc('execute_client_mutation',{p_operation_id:legacyId,p_name:'create_project',p_args:legacyArgs});
 const legacyProject=await value(legacy());
 const deniedId=randomUUID(),deniedArgs={p_project_id:legacyProject,p_identifier:'absent@window.test',p_role:'member'};
 const denial=()=>client.rpc('execute_client_mutation',{p_operation_id:deniedId,p_name:'add_project_member_by_identifier',p_args:deniedArgs});
 const oldDenial=await denial();assert.equal(oldDenial.status,400);
 const legacyTask=await value(client.rpc('create_task',{p_project_id:legacyProject,p_title:'Legacy stage'}));
 const legacyItem=await value(client.rpc('create_task_item',{p_task_id:legacyTask,p_title:'Legacy item'}));
 const legacyItemId=randomUUID();
 const oldItem=await value(client.rpc('apply_task_item_percentage_operation_v2',{p_operation_id:legacyItemId,p_task_item_id:legacyItem,p_expected_version:1,p_percentage:30}));
 if(upgrade){
  for(const file of readdirSync('supabase/migrations').filter(n=>n.slice(0,14)>='20261023115036').sort())env.sql('set role postgres;\n'+readFileSync(resolve('supabase/migrations',file),'utf8'));
  env.sql(receiptTestPolicySql);
  let loaded=false;for(let n=0;n<50;n++){const schema=await (await fetch(api.url,{headers:{Authorization:'Bearer '+api.token(u)}})).json();if(schema.paths?.['/rpc/get_client_operation_context']){loaded=true;break;}await new Promise(r=>setTimeout(r,100));}assert(loaded,'New PostgREST schema unavailable');
 }
 await check('legacy upgrade preserves exact UUID, HTTP denial and v2 version-excluding fingerprint',async()=>{
  assert.equal(await value(legacy()),legacyProject);const nextDenial=await denial();assert.equal(nextDenial.status,400);assert.deepEqual(nextDenial.error,oldDenial.error);
  assert.deepEqual(await value(client.rpc('apply_task_item_percentage_operation_v2',{p_operation_id:legacyItemId,p_task_item_id:legacyItem,p_expected_version:99,p_percentage:30})),oldItem);
 });
 // A full legacy account must not consume the separate v3 live-window budget.
 await env.db.query('update private.client_operation_policy set max_receipts=(select count(*) from private.client_operation_receipts where user_id=$1)',[u]);
 const context=await value(client.rpc('get_client_operation_context'));
 const args={p_name:'Window project'},id=randomUUID();
 const call=(oid=id,payload=args,ctx=context)=>client.rpc('execute_client_mutation_v3',{p_generation:ctx.generation,p_epoch:ctx.epoch,p_operation_id:oid,p_name:'create_project',p_args:payload});
 let project;
 await check('v3 first call and exact replay',async()=>{project=await value(call());assert.equal(await value(call()),project);});
 await check('same ID changed payload rejected',async()=>assert.equal((await call(id,{p_name:'changed'})).error?.code,'22023'));
 await check('concurrent identical ID one effect',async()=>{const oid=randomUUID();const results=await Promise.all(Array.from({length:8},()=>value(call(oid,{p_name:'Concurrent window'}))));assert.equal(new Set(results).size,1);assert.equal((await env.db.query("select count(*)::int n from public.projects where name='Concurrent window'")).rows[0].n,1);});
 await check('resolution returns the committed receipt',async()=>{const result=await value(client.rpc('resolve_client_operation_v3',{p_generation:context.generation,p_epoch:context.epoch,p_operation_id:id,p_type:'rpc:create_project',p_target:id,p_payload:args}));assert.equal(result.state,'completed');assert.equal(result.result.value,project);});
 await check('cross-account ID cannot read another receipt',async()=>{const result=await value(api.client(other).rpc('resolve_client_operation_v3',{p_generation:context.generation,p_epoch:context.epoch,p_operation_id:id,p_type:'rpc:create_project',p_target:id,p_payload:args}));assert.equal(result.state,'unknown');});
 await check('private functions and lifecycle are not client callable',async()=>{const r=await asUser(env.db,u,()=>env.db.query("select has_function_privilege('authenticated','private.invoke_client_mutation_v3(uuid,text,jsonb)','execute') as can_invoke,has_function_privilege('authenticated','private.run_client_operation_lifecycle(integer)','execute') as can_gc"));assert.deepEqual(r.rows[0],{can_invoke:false,can_gc:false});});
 const task=await value(client.rpc('create_task',{p_project_id:project,p_title:'Window task'}));
 const item=await value(client.rpc('create_task_item',{p_task_id:task,p_title:'Window item'}));
 const version=async()=>(await env.db.query('select sync_version from public.task_items where id=$1',[item])).rows[0].sync_version;
 const base=Number(await version()),op=randomUUID();
 const edit=(oid,expected,percentage)=>client.rpc('apply_task_item_percentage_operation_v3',{p_generation:context.generation,p_epoch:context.epoch,p_operation_id:oid,p_task_item_id:item,p_expected_version:expected,p_percentage:percentage});
 await check('CAS applied and replay does not advance version',async()=>{const first=await value(edit(op,base,42));assert.equal(first.status,'applied');assert.deepEqual(await value(edit(op,base,42)),first);assert.equal(Number(await version()),first.version);});
 await check('CAS conflict terminal and expected_version immutable',async()=>{const oid=randomUUID(),first=await value(edit(oid,base,80));assert.equal(first.status,'conflict');assert.equal((await edit(oid,first.version,80)).error?.code,'22023');assert.deepEqual(await value(edit(oid,base,80)),first);});
 await check('concurrent devices with distinct IDs and one CAS version have one winner',async()=>{
  const before=Number(await version()),results=await Promise.all([value(edit(randomUUID(),before,31)),value(edit(randomUUID(),before,73))]);
  assert.deepEqual(results.map(r=>r.status).sort(),['applied','conflict']);assert.equal(Number(await version()),before+1);
 });
 await check('accepted no-op advances version',async()=>{const before=Number(await version()),percentage=(await env.db.query('select percentage from public.task_items where id=$1',[item])).rows[0].percentage,r=await value(edit(randomUUID(),before,percentage));assert(r.version>before);});
 await check('revoked access redacts a completed receipt and deleted accounts cannot replay',async()=>{
  await value(client.rpc('add_project_member',{p_project_id:project,p_user_id:other,p_role:'member'}));
  const oid=randomUUID(),expected=Number(await version()),foreign=api.client(other);
  const replay=()=>foreign.rpc('apply_task_item_comment_operation_v3',{p_generation:context.generation,p_epoch:context.epoch,p_operation_id:oid,p_task_item_id:item,p_expected_version:expected,p_comment:'Synthetic private comment'});
  assert.equal((await value(replay())).status,'applied');
  await value(client.rpc('remove_project_member',{p_project_id:project,p_user_id:other}));
  assert.deepEqual(await value(replay()),{state:'result_redacted',terminal:true});
  // Supabase soft deletion retains the Auth row (audit FKs may prevent hard
  // deletion). A still-valid signed JWT must no longer authorize a replay.
  await env.db.query('update auth.users set deleted_at=clock_timestamp() where id=$1',[other]);assert.equal((await replay()).error?.code,'28000');
 });
 await check('deleting the business entity never deletes its receipt or resurrects the item',async()=>{
  await value(client.rpc('archive_task_item',{p_task_item_id:item}));
  await value(client.rpc('hard_delete_task_item',{p_task_item_id:item}));
  assert.deepEqual(await value(edit(op,base,42)),{state:'result_redacted',terminal:true});
  assert.equal((await env.db.query('select count(*)::int n from public.task_items where id=$1',[item])).rows[0].n,0);
  assert.equal((await env.db.query('select count(*)::int n from private.client_operation_receipts_v3 where operation_id=$1',[op])).rows[0].n,1);
 });
 await check('result overflow rolls back business effect AND reservation',async()=>{
  const before=(await env.db.query('select * from private.client_operation_live_budgets order by scope')).rows;
  await env.db.query('update private.client_operation_window_policy set max_result_bytes=1');
  const r=await call(randomUUID(),{p_name:'Result must roll back'});assert.equal(r.error?.code,'PT507');
  assert.equal((await env.db.query("select count(*)::int n from public.projects where name='Result must roll back'")).rows[0].n,0);
  assert.deepEqual((await env.db.query('select * from private.client_operation_live_budgets order by scope')).rows,before);
  await env.db.query('update private.client_operation_window_policy set max_result_bytes=1048576');
 });
 await check('live receipt cannot be deleted',async()=>{await assert.rejects(env.db.query('delete from private.client_operation_receipts_v3 where operation_id=$1',[id]),e=>e.code==='22023');});
 await check('legacy cutoff closes EVERY unknown old claim while known replay survives',async()=>{
  await env.db.query("update private.client_operation_window_policy set legacy_admit_until=private.operation_clock()-interval '1 second',legacy_replay_until=private.operation_clock()+interval '90 days'");
  await env.db.query('select private.advance_legacy_operation_lifecycle()');
  assert.equal(await value(legacy()),legacyProject);
  assert.equal((await client.rpc('execute_client_mutation',{p_operation_id:randomUUID(),p_name:'create_project',p_args:{p_name:'Forbidden legacy reopen'}})).error?.details,'TT_OPERATION_NOT_APPLIED');
  assert.equal((await client.rpc('apply_task_item_percentage_operation_v2',{p_operation_id:randomUUID(),p_task_item_id:legacyItem,p_expected_version:oldItem.version,p_percentage:50})).error?.details,'TT_OPERATION_NOT_APPLIED');
  assert.equal((await env.db.query("select count(*)::int n from public.projects where name='Forbidden legacy reopen'")).rows[0].n,0);
 });
 let managedClock=false;
 const setTime=async ms=>{
  if(!managedClock){await env.db.query("create table private.laboratory_operation_clock(value timestamptz not null);alter table private.laboratory_operation_clock enable row level security;revoke all on private.laboratory_operation_clock from public,anon,authenticated,service_role;insert into private.laboratory_operation_clock values(clock_timestamp());create or replace function private.operation_clock() returns timestamptz language sql volatile set search_path='' as $$ select value from private.laboratory_operation_clock $$");managedClock=true;}
  await env.db.query('update private.laboratory_operation_clock set value=$1',[new Date(ms).toISOString()]);
 };
 const initial=Date.parse(context.admit_until)-86400000;
 const independent=connect(env.port,env.database,'window_verifier');await independent.connect();
 await check('independent SQL connection observes effect and receipt together',async()=>{const r=await independent.query('select exists(select 1 from public.projects where id=$1) effect,exists(select 1 from private.client_operation_receipts_v3 where operation_id=$2 and outcome is not null) receipt',[project,id]);assert.deepEqual(r.rows[0],{effect:true,receipt:true});});await independent.end();
 await check('deadline crossed while waiting for budget lock cannot admit an operation',async()=>{
  await setTime(initial+1000);
  const lock=connect(env.port,env.database,'budget_blocker');await lock.connect();
  try{
   await lock.query('begin');await lock.query("select 1 from private.client_operation_live_budgets where scope='global' for update");
   const oid=randomUUID(),pending=call(oid,{p_name:'Delayed admission'}).then(r=>r);
   let waiting=false;for(let n=0;n<100;n++){waiting=(await env.db.query("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%execute_client_mutation_v3%') waiting")).rows[0].waiting;if(waiting)break;await new Promise(r=>setTimeout(r,20));}assert(waiting);
   await setTime(Date.parse(context.admit_until)+1000);await lock.query('rollback');const r=await pending;assert.equal(r.error?.code,'TT_OPERATION_WINDOW_CLOSING');
   const resolution=await value(client.rpc('resolve_client_operation_v3',{p_generation:context.generation,p_epoch:context.epoch,p_operation_id:oid,p_type:'rpc:create_project',p_target:oid,p_payload:{p_name:'Delayed admission'}}));assert.equal(resolution.state,'not_applied');
   assert.equal((await env.db.query("select count(*)::int n from public.projects where name='Delayed admission'")).rows[0].n,0);
  }finally{await lock.end();}
 });
 for(const [label,delay] of [['hour',3600000],['days',3*86400000],['months',60*86400000]]){
  await check('real receipt replay after '+label,async()=>{await setTime(initial+delay);assert.equal(await value(call()),project);});
 }
 await check('closed admission gives not_applied and cannot reopen on clock rollback',async()=>{
  const oid=randomUUID();const resolve=()=>client.rpc('resolve_client_operation_v3',{p_generation:context.generation,p_epoch:context.epoch,p_operation_id:oid,p_type:'rpc:create_project',p_target:oid,p_payload:args});
  assert.equal((await value(resolve())).state,'not_applied');
  await setTime(initial+1000);assert.equal((await call(oid)).error?.code,'TT_OPERATION_NOT_APPLIED');
  assert.equal((await env.db.query('select count(*)::int n from private.client_operation_receipts_v3 where operation_id=$1',[oid])).rows[0].n,0);
 });
 await check('unknown closed-epoch requests never allocate permanent idle-user budgets',async()=>{
  const idle=randomUUID();await env.db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')",[idle,idle+'@idle-window.test']);
  const result=await api.client(idle).rpc('execute_client_mutation_v3',{p_generation:context.generation,p_epoch:context.epoch,
   p_operation_id:randomUUID(),p_name:'create_project',p_args:{p_name:'Never admitted idle user'}});
  assert.equal(result.error?.code,'TT_OPERATION_NOT_APPLIED');
  assert.equal((await env.db.query('select count(*)::int n from private.client_operation_live_budgets where scope=$1',['user:'+idle])).rows[0].n,0);
  assert.equal((await env.db.query("select count(*)::int n from public.projects where name='Never admitted idle user'")).rows[0].n,0);
 });
 let capacityContext;const capacityId=randomUUID();
 await check('full live budget rejects admission but preserves known replay',async()=>{
  capacityContext=await value(client.rpc('get_client_operation_context'));
  const before=(await env.db.query("select receipt_count from private.client_operation_live_budgets where scope=$1",['user:'+u])).rows[0].receipt_count;
  await env.db.query('update private.client_operation_window_policy set max_receipts=$1',[Number(before)+1]);
  await value(call(capacityId,{p_name:'Capacity admitted'},capacityContext));
  assert.equal((await call(randomUUID(),{p_name:'Capacity denied'},capacityContext)).error?.code,'PT507');assert.equal(await value(call()),project);
 });
 await check('GC rollback and interruption preserve exact accounting',async()=>{
  await setTime(Date.parse(capacityContext.replay_until)+1000);
  await env.db.query('select private.retire_client_operation_epoch($1,$2)',[context.generation,context.epoch]);
  const before=(await env.db.query('select * from private.client_operation_live_budgets order by scope')).rows;
  await env.db.query('begin');await env.db.query('select private.prune_client_operation_receipts($1,$2,1)',[context.generation,context.epoch]);await env.db.query('rollback');
  assert.deepEqual((await env.db.query('select * from private.client_operation_live_budgets order by scope')).rows,before);
 });
 await check('concurrent replay and GC cannot execute an old operation twice',async()=>{
  const [,replayed]=await Promise.all([env.db.query('select private.prune_client_operation_receipts($1,$2,1)',[context.generation,context.epoch]),call()]);
  assert.equal(replayed.error?.code,'TT_OPERATION_EXPIRED');
  const rows=(await env.db.query('select coalesce(sum(accounted_bytes),0)::text bytes,count(*)::text n from private.client_operation_receipts_v3')).rows[0];
  const budget=(await env.db.query("select logical_bytes::text bytes,receipt_count::text n from private.client_operation_live_budgets where scope='global'")).rows[0];assert.deepEqual(budget,rows);
 });
 await check('two lifecycle workers serialize without shared-to-exclusive lock upgrades',async()=>{
  const cleaner=connect(env.port,env.database,'second_window_cleaner');await cleaner.connect();
  try {await Promise.all([env.db.query('select private.run_client_operation_lifecycle(1)'),cleaner.query('select private.run_client_operation_lifecycle(1)')]);}
  finally {await cleaner.end();}
  const rows=(await env.db.query('select coalesce(sum(accounted_bytes),0)::text bytes,count(*)::text n from private.client_operation_receipts_v3')).rows[0];
  const budget=(await env.db.query("select logical_bytes::text bytes,receipt_count::text n from private.client_operation_live_budgets where scope='global'")).rows[0];assert.deepEqual(budget,rows);
 });
 await check('cleanup restores admission and a deleted old ID NEVER executes',async()=>{
  for(let n=0;n<100;n++){await env.db.query('select private.run_client_operation_lifecycle(2)');if(!(await env.db.query('select count(*)::int n from private.client_operation_receipts_v3')).rows[0].n)break;}
  assert.equal((await env.db.query('select count(*)::int n from private.client_operation_receipts_v3')).rows[0].n,0);
  assert.equal(Number((await env.db.query("select receipt_count from private.client_operation_live_budgets where scope='global'")).rows[0].receipt_count),0);
  assert.equal((await call()).error?.code,'TT_OPERATION_EXPIRED');
  assert.equal((await legacy()).error?.details,'TT_OPERATION_EXPIRED');
  assert.equal((await env.db.query('select count(*)::int n from private.client_operation_receipts')).rows[0].n,0);
  const next=await value(client.rpc('get_client_operation_context'));assert.equal(typeof await value(call(randomUUID(),{p_name:'Capacity recovered'},next)),'string');
  assert.equal((await env.db.query("select count(*)::int n from public.projects where name='Capacity recovered'")).rows[0].n,1);
 });
 await check('years-old and forged epochs never create receipts',async()=>{
  await setTime(initial+10*365*86400000);assert.equal((await call()).error?.code,'TT_OPERATION_EXPIRED');
  assert.equal((await call(randomUUID(),args,{...context,epoch:999999})).error?.code,'TT_OPERATION_INVALID_EPOCH');
 });
 await check('generation reset rejects every old handle',async()=>{await env.db.query('select private.rotate_client_operation_history()');assert.equal((await call()).error?.code,'TT_OPERATION_HISTORY_RESET');});
 }
}finally{writeFileSync(resolve(dir,'results.json'),JSON.stringify(evidence,null,2));api?.close();await env.close();}
