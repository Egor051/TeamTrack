// Real PostgREST + isolated upgrade, including sessions opened before cutover.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createSecurityDatabase, root } from './security-test-harness.mjs';
import { startSecurityApi } from './security-test-api.mjs';
const env=await createSecurityDatabase({beforeVersion:'20261021144300'});let api,legacy;
const value=async q=>{const r=await q;if(r.error)throw r.error;return r.data;};
const snapshot=async()=> (await env.db.query(`select md5(jsonb_build_array(
 (select jsonb_agg(to_jsonb(t) order by id) from public.projects t),
 (select jsonb_agg(to_jsonb(t) order by id) from public.tasks t),
 (select jsonb_agg(to_jsonb(t) order by id) from public.task_items t),
 (select jsonb_agg(to_jsonb(t) order by id) from public.profiles t),
 (select jsonb_agg(to_jsonb(t) order by id) from public.task_templates t),
 (select jsonb_agg(to_jsonb(t) order by id) from public.task_template_items t),
 (select jsonb_agg(to_jsonb(t) order by id) from public.audit_log t),
 (select jsonb_agg(to_jsonb(t) order by id) from public.notifications t),
 (select jsonb_agg(to_jsonb(t) order by id) from public.item_actions t),
 (select jsonb_agg(to_jsonb(t) order by user_id,operation_id) from private.client_operation_receipts t)
 )::text) hash`)).rows[0].hash;
try{
 api=await startSecurityApi(env);
 const owner=randomUUID(),outsider=randomUUID();
 for(const id of [owner,outsider])await env.db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[id,id+'@write-protocol.invalid',{display_name:'Protocol fixture'}]);
 const client=api.client(owner),stranger=api.client(outsider);
 const project=await value(client.rpc('create_project',{p_name:'Project baseline',p_description:'Original'}));
 const task=await value(client.rpc('create_task',{p_project_id:project,p_title:'Task baseline',p_description:'Original'}));
 const item=await value(client.rpc('create_task_item',{p_task_id:task,p_title:'Item baseline'}));
 const template=await value(client.rpc('create_task_template',{p_name:'Template baseline',p_description:'Original'}));
 const templateItem=await value(client.rpc('create_task_template_item',{p_template_id:template,p_title:'Template item baseline',p_description:'Original'}));
 const receipts=[
  ['apply_task_item_state_operation',{p_operation_id:randomUUID(),p_task_item_id:item,p_completed:true}],
  ['apply_task_item_percentage_operation',{p_operation_id:randomUUID(),p_task_item_id:item,p_percentage:45}],
  ['apply_task_item_comment_operation',{p_operation_id:randomUUID(),p_task_item_id:item,p_comment:'Before upgrade'}],
 ];
 for(const r of receipts)r.push(await value(client.rpc(r[0],r[1])));
 let version=Number((await env.db.query('select sync_version from public.task_items where id=$1',[item])).rows[0].sync_version);
 await value(client.rpc('set_task_item_comment',{p_task_item_id:item,p_comment:'New client committed edit',p_expected_version:version}));
 // Keep a real old body in flight across the migration, waiting at its parent.
 legacy=new pg.Client({host:'127.0.0.1',port:env.port,database:env.database,user:'supabase_admin',password:'postgres',application_name:'tt_regression_old_body',statement_timeout:15000});await legacy.connect();
 await env.db.query('begin');await env.db.query('select id from public.projects where id=$1 for update',[project]);
 await legacy.query('begin');await legacy.query('set local role authenticated');await legacy.query("select set_config('request.jwt.claim.sub',$1,true)",[owner]);
 const late=legacy.query('select public.set_task_item_comment($1,$2)',[item,'Late legacy overwrite']).then(()=>null,error=>error);
 const until=Date.now()+5000;let waiting=false;
 while(Date.now()<until){if((await env.db.query("select 1 from pg_stat_activity where application_name='tt_regression_old_body' and wait_event_type='Lock'")).rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,20));}
 assert(waiting,'legacy body must really wait before migration');
 env.sql('set role postgres;\n'+readFileSync(root+'/supabase/migrations/20261021144300_regression_write_protocol.sql','utf8'));
 await env.db.query('commit');assert.equal((await late)?.code,'PT426');await legacy.query('rollback');
 assert.equal((await value(client.from('task_items').select('comment').eq('id',item).single())).comment,'New client committed edit');
 console.log('PASS REG-03: in-flight pre-cutover legacy body is fenced; newer committed edit survives');
 for(const [name,args,result] of receipts){const before=await snapshot();assert.deepEqual(await value(client.rpc(name,args)),result);assert.equal(await snapshot(),before);}
 console.log('PASS REG-03: all three completed v1 receipts replay after upgrade without new effects');
 const cases=[
  ['update_project',{p_project_id:project,p_name:'Project modern',p_description:'Saved',p_expected_name:'Project baseline',p_expected_description:'Original'},{p_project_id:project,p_name:'Legacy overwrite',p_description:'Stale'}],
  ['update_task',{p_task_id:task,p_title:'Task modern',p_description:'Saved',p_expected_title:'Task baseline',p_expected_description:'Original'},{p_task_id:task,p_title:'Legacy overwrite',p_description:'Stale'}],
  ['update_task_template',{p_template_id:template,p_name:'Template modern',p_description:'Saved',p_expected_name:'Template baseline',p_expected_description:'Original'},{p_template_id:template,p_name:'Legacy overwrite',p_description:'Stale'}],
  ['update_task_template_item',{p_item_id:templateItem,p_title:'Template item modern',p_description:'Saved',p_expected_title:'Template item baseline',p_expected_description:'Original'},{p_item_id:templateItem,p_title:'Legacy overwrite',p_description:'Stale'}],
  ['update_task_item',{p_task_item_id:item,p_title:'Item modern'},{p_task_item_id:item,p_title:'Legacy overwrite',p_description:'Stale',p_position:2}],
  ['set_task_item_comment',{p_task_item_id:item,p_comment:'Modern saved'},{p_task_item_id:item,p_comment:'Legacy overwrite'}],
  ['set_task_item_percentage',{p_task_item_id:item,p_percentage:80},{p_task_item_id:item,p_percentage:5}],
  ['set_task_item_state',{p_task_item_id:item,p_completed:true},{p_task_item_id:item,p_completed:false}],
  ['update_my_profile',{p_display_name:'Modern profile',p_expected_display_name:'Protocol fixture'},{p_display_name:'Legacy profile'}],
 ];
 for(const [name,args,old] of cases){
  if('p_task_item_id'in args)args.p_expected_version=Number((await env.db.query('select sync_version from public.task_items where id=$1',[item])).rows[0].sync_version);
  await value(client.rpc(name,args));const before=await snapshot();
  const refused=await client.rpc(name,old);assert.equal(refused.error?.code,'PT426',name);assert.match(refused.error.message,/Обновите приложение/);assert.equal(refused.status,426);assert.equal(await snapshot(),before,name+': legacy changed data/audit/receipts');
  assert.equal((await client.rpc('execute_client_mutation',{p_operation_id:randomUUID(),p_name:name,p_args:old})).error?.code,'PT426');assert.equal(await snapshot(),before);
  if(name!=='update_my_profile')assert((await stranger.rpc(name,args)).error,name+': new CAS ACL bypass');
  else assert.equal((await value(stranger.rpc(name,args))).id,outsider,'profile remains self-scoped');
  console.log('PASS REG-03: '+name+' CAS works; legacy/direct executor refuse without effects');
 }
 for(const [name,args]of receipts){const before=await snapshot();assert.equal((await client.rpc(name,{...args,p_operation_id:randomUUID()})).error?.code,'PT426');assert.equal(await snapshot(),before);}
 assert.equal((await client.rpc('set_task_item_progress',{p_task_item_id:item,p_completion_percent:10})).error?.code,'PT426');
 const current=await value(client.from('task_items').select('*').eq('id',item).single());
 const concurrent=await Promise.all(['First','Second'].map(p_comment=>client.rpc('set_task_item_comment',{p_task_item_id:item,p_comment,p_expected_version:current.sync_version})));
 assert.equal(concurrent.filter(r=>!r.error).length,1);assert.equal(concurrent.find(r=>r.error)?.error.code,'PT409');
 const v=Number((await env.db.query('select sync_version from public.task_items where id=$1',[item])).rows[0].sync_version),operation=randomUUID();
 const replayArgs={p_operation_id:operation,p_task_item_id:item,p_expected_version:v,p_percentage:90};
 const [one,two]=await Promise.all([value(client.rpc('apply_task_item_percentage_operation_v2',replayArgs)),value(client.rpc('apply_task_item_percentage_operation_v2',replayArgs))]);assert.deepEqual(one,two);assert.equal(one.status,'applied');
 assert.equal((await env.db.query("select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='private' and p.proname like '%_unchecked' and (has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('anon',p.oid,'execute') or has_function_privilege('service_role',p.oid,'execute'))")).rows[0].n,0);
 console.log('PASS REG-03: concurrent CAS has one winner; v2 receipts retain exactly-once replay; private setters inaccessible');
}finally{await env.db.query('rollback').catch(()=>undefined);if(legacy){await legacy.query('rollback').catch(()=>undefined);await legacy.end();}api?.close();await env.close();}
