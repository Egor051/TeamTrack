import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSecurityDatabase,asUser } from './security-test-harness.mjs';
import { startSecurityApi } from './security-test-api.mjs';
import { maintenanceSql } from './release-manifest.mjs';
const env=await createSecurityDatabase({beforeVersion:'20261022201114'});let api;
const results=[];const out=resolve('.expo/release-acceptance');mkdirSync(out,{recursive:true});
const check=async(name,fn)=>{await fn();results.push({name,result:'PASS'});console.log('PASS '+name);};
const value=async query=>{const r=await query;if(r.error)throw Object.assign(Error(r.error.message),r.error);return r.data;};
try {
 api=await startSecurityApi(env);const u=randomUUID();
 await env.db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')",[u,u+'@release.invalid']);
 const client=api.client(u);await value(client.rpc('create_project',{p_name:'Before maintenance'}));
 env.sql('set role postgres;\n'+maintenanceSql());
 const blocked=async()=>{const r=await client.rpc('create_project',{p_name:'Must not appear'});assert.equal(r.status,503,JSON.stringify(r));assert.equal((await env.db.query("select count(*)::int n from public.projects where name='Must not appear'")).rows[0].n,0);};
 await check('F04 maintenance preflight blocks real old RPC before migration 1',blocked);
 for(const file of readdirSync('supabase/migrations').filter(n=>n>='20261022201114').sort()) {
  env.sql('set role postgres;\n'+readFileSync(resolve('supabase/migrations',file),'utf8'));
  await check('F04 write fence remains closed after '+file,blocked);
 }
 // PostgREST reload is asynchronous, with a bounded observed readiness check.
 let loaded=false;for(let n=0;n<100;n++){const r=await client.rpc('get_client_operation_context');if(r.error?.code!=='PGRST202'){loaded=true;break;}await new Promise(r=>setTimeout(r,100));}assert(loaded);
 await check('F04 maintenance cannot open with either NULL policy',async()=>{
  await assert.rejects(env.db.query('select private.set_release_maintenance(false)'),e=>e.code==='PT503');
  const before=(await env.db.query('select to_jsonb(p) value from private.client_operation_policy p')).rows[0].value;
  await assert.rejects(env.db.query("select private.configure_client_operation_release('{}','{}')"));
  assert.deepEqual((await env.db.query('select to_jsonb(p) value from private.client_operation_policy p')).rows[0].value,before);
 });
 const legacy={max_receipts:25000,max_logical_bytes:33554432,max_request_bytes:524288,max_result_bytes:262144,new_per_minute:120};
 const window={...legacy,admission_seconds:86400,replay_seconds:2592000,max_global_receipts:500000,max_global_bytes:536870912,
  legacy_admit_until:new Date(Date.now()+30*86400000).toISOString(),legacy_replay_until:new Date(Date.now()+120*86400000).toISOString()};
 await check('F04 both policies initialize atomically and the explicit open succeeds',async()=>{
  await env.db.query('select private.configure_client_operation_release($1,$2)',[legacy,window]);
  assert.equal((await client.rpc('get_client_operation_context')).status,503,'Configured policy must not bypass maintenance');
  await env.db.query('select private.set_release_maintenance(false)');
  await value(client.rpc('execute_client_mutation',{p_operation_id:randomUUID(),p_name:'create_project',p_args:{p_name:'Allowed legacy'}}));
 });
 const context=await value(client.rpc('get_client_operation_context'));const raw=randomUUID(),id=raw.slice(0,14)+'8'+raw.slice(15),args={p_name:'One v3 effect'};
 const v3=()=>client.rpc('execute_client_mutation_v3',{p_generation:context.generation,p_epoch:context.epoch,p_operation_id:id,p_name:'create_project',p_args:args});
 await check('F01 server rejects v3 UUID in legacy while preserving true v3 replay',async()=>{
  assert.equal(await value(v3()),await value(v3()));
  const old=await client.rpc('execute_client_mutation',{p_operation_id:id,p_name:'create_project',p_args:args});
  assert.equal(old.status,409);assert.equal(old.error.details,'TT_OPERATION_NAMESPACE');
  assert.equal((await env.db.query("select count(*)::int n from public.projects where name='One v3 effect'")).rows[0].n,1);
 });
 await check('F05 deleted account has no business effect through every inventoried signature',async()=>{
  const inventory=(await env.db.query('select * from private.mutation_entry_inventory order by signature')).rows;
  assert(inventory.length>=40);writeFileSync(resolve(out,'mutation-entry-inventory.json'),JSON.stringify(inventory,null,2));
  await env.db.query('update auth.users set deleted_at=clock_timestamp() where id=$1',[u]);
  for(const entry of inventory) {
   const proc=(await env.db.query('select proargtypes::oid[] types,pronargs from pg_proc where oid=$1::regprocedure',[entry.signature])).rows[0];
   const types=Array.isArray(proc.types)?proc.types:Object.values(proc.types);
   const expression=types.map(t=>'null::'+(Number(t)===2276?'text':String(Number(t))+'::regtype')).join(',');
   // Use format_type from PostgreSQL; arguments are typed NULL so each overload
   // is tested without constructing a valid destructive business request.
   const cast=(await env.db.query("select string_agg('null::'||format_type(t,null),',' order by ord) args from unnest((select proargtypes::oid[] from pg_proc where oid=$1::regprocedure)) with ordinality a(t,ord)",[entry.signature])).rows[0].args??'';
   const fn=entry.signature.slice(0,entry.signature.indexOf('('));
   await assert.rejects(asUser(env.db,u,()=>env.db.query('select '+fn+'('+cast+')')),e=>['28000','42501'].includes(e.code),entry.signature+' '+expression);
  }
  assert.equal((await env.db.query("select count(*)::int n from public.projects where name='One v3 effect'")).rows[0].n,1);
  await env.db.query('update auth.users set deleted_at=null where id=$1',[u]);
 });
 await check('F05 cutover closes direct new business RPC while v3 stays operational',async()=>{
  await env.db.query("update private.client_operation_window_policy set legacy_admit_until=clock_timestamp()-interval '2 days',legacy_replay_until=clock_timestamp()-interval '1 day';select private.advance_legacy_operation_lifecycle()");
  const old=await client.rpc('create_project',{p_name:'Closed direct'});assert.equal(old.status,426,JSON.stringify(old));
  assert.equal((await env.db.query("select count(*)::int n from public.projects where name='Closed direct'")).rows[0].n,0);
  const raw=randomUUID(),next=raw.slice(0,14)+'8'+raw.slice(15);
  await value(client.rpc('execute_client_mutation_v3',{p_generation:context.generation,p_epoch:context.epoch,p_operation_id:next,p_name:'create_project',p_args:{p_name:'V3 after cutover'}}));
 });
 await check('F01 UUID namespace fence survives GC and legacy reopening attempts',async()=>{
  const future=new Date(Date.parse(context.replay_until)+1000).toISOString();
  await env.db.query(`create or replace function private.operation_clock() returns timestamptz language sql volatile set search_path='' as $$select '${future}'::timestamptz$$`);
  await env.db.query('select private.run_client_operation_lifecycle(500)');
  assert.equal((await env.db.query('select count(*)::int n from private.client_operation_receipts_v3 where operation_id=$1',[id])).rows[0].n,0);
  const old=await client.rpc('execute_client_mutation',{p_operation_id:id,p_name:'create_project',p_args:args});assert.equal(old.status,409);assert.equal(old.error.details,'TT_OPERATION_NAMESPACE');
  assert.equal((await env.db.query("select count(*)::int n from public.projects where name='One v3 effect'")).rows[0].n,1);
 });
}finally{writeFileSync(resolve(out,'blockers-results.json'),JSON.stringify(results,null,2));api?.close();await env.close();}
