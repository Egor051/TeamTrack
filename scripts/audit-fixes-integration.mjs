// Real PostgreSQL + PostgREST in a disposable teamtrack_audit_* database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSecurityDatabase } from './security-test-harness.mjs';
import { startSecurityApi } from './security-test-api.mjs';
import { receiptTestPolicySql } from './receipt-test-policy.mjs';
const firstMigration='20261022201114',upgrade=process.argv.includes('--upgrade');
const env = await createSecurityDatabase({beforeVersion:upgrade?firstMigration:null}); let api;
const failures = []; let passed = 0;
const check = async (label, work) => { const started=performance.now(); try { await work(); passed++; console.log('PASS '+label+' ('+Math.round(performance.now()-started)+' ms)'); } catch (e) { failures.push(label); console.error('FAIL '+label+': '+e.message); } };
const value = async query => { const r = await query; if (r.error) throw r.error; return r.data; };
try {
  api = await startSecurityApi(env);
  const user = randomUUID(), other = randomUUID();
  for (const id of [user,other]) await env.db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)',[id,id+'@audit-fixes.test',{display_name:'Audit fixes '+id}]);
  const client = api.client(user);
  const mutation = (name,args={},id=randomUUID()) => client.rpc('execute_client_mutation',{p_operation_id:id,p_name:name,p_args:args});
  const rawMutation=async(name,args,id)=>{const response=await fetch(api.url+'/rpc/execute_client_mutation',{method:'POST',headers:{Authorization:'Bearer '+api.token(user),'Content-Type':'application/json'},body:JSON.stringify({p_operation_id:id,p_name:name,p_args:args})});
    return {status:response.status,headers:response.headers,body:await response.json()};};
  const project = await value(mutation('create_project',{p_name:'Audit fixes'}));
  const task = await value(mutation('create_task',{p_project_id:project,p_title:'Snapshot'}));
  const foreign = await value(mutation('create_task',{p_project_id:project,p_title:'Other stage'}));
  await env.db.query("insert into public.task_items(task_id,title,position) select $1,'Item '||n,n from generate_series(1,501) n",[task]);
  const deniedId=randomUUID(),quotaId=randomUUID(),deniedArgs={p_project_id:project,p_identifier:'missing@audit-fixes.test',p_role:'member'};
  if(upgrade){
    assert.equal((await mutation('add_project_member_by_identifier',deniedArgs,deniedId)).status,400);
    await env.db.query("update private.member_identifier_limits set attempts=20,window_start=date_trunc('minute',clock_timestamp()) where user_id=$1",[user]);
    assert.equal((await mutation('add_project_member_by_identifier',deniedArgs,quotaId)).status,429);
    await env.db.query('update private.member_identifier_limits set attempts=1 where user_id=$1',[user]);
    for(const file of readdirSync(resolve('supabase/migrations')).filter(n=>n.slice(0,14)>=firstMigration).sort())env.sql('set role postgres;\n'+readFileSync(resolve('supabase/migrations',file),'utf8'));
    env.sql(receiptTestPolicySql); await new Promise(r=>setTimeout(r,400));
    console.log('PASS upgrade: existing items and historical receipt preserved');
  }
  await check('B04 unrelated writes do not change a task snapshot',async()=>{
    const first = await value(client.rpc('get_task_item_snapshot_page',{p_task_id:task}));
    await value(mutation('create_task_item',{p_task_id:foreign,p_title:'Unrelated'}));
    const last = await value(client.rpc('get_task_item_snapshot_page',{p_task_id:task,p_offset:500,p_revision:first.revision}));
    assert.equal(last.rows.length,1); assert.equal(last.revision,first.revision);
  });
  await check('B01 business denial replay retains HTTP 400 and consumes one lookup',async()=>{
    const id=deniedId, args=deniedArgs;
    const first=await mutation('add_project_member_by_identifier',args,id);
    const attempts=(await env.db.query('select attempts from private.member_identifier_limits where user_id=$1',[user])).rows[0].attempts;
    const replay=await mutation('add_project_member_by_identifier',args,id);
    assert.equal(first.status,400); assert.equal(replay.status,400); assert.deepEqual(replay.error,first.error);
    assert.equal((await env.db.query('select attempts from private.member_identifier_limits where user_id=$1',[user])).rows[0].attempts,attempts);
  });
  await check('B02 a receipt does not read notifications created after its commit',async()=>{
    const seed=async key=>env.db.query("insert into public.notifications(user_id,type,title,body,dedupe_key) values($1,'task_assigned',$2,'body',$2) returning id",[user,key]);
    await seed('old'); const id=randomUUID(); await value(mutation('mark_all_notifications_read',{},id));
    const fresh=(await seed('new')).rows[0].id;
    await value(mutation('mark_all_notifications_read',{},id));
    assert.equal((await env.db.query('select is_read from public.notifications where id=$1',[fresh])).rows[0].is_read,false);
    await value(mutation('mark_all_notifications_read'));
    assert.equal((await env.db.query('select is_read from public.notifications where id=$1',[fresh])).rows[0].is_read,true);
  });
  await check('B01 HTTP 429 replay preserves body, quota and remaining Retry-After',async()=>{
    try{
      if(!upgrade)await env.db.query("update private.member_identifier_limits set attempts=20,window_start=date_trunc('minute',clock_timestamp()) where user_id=$1",[user]);
      const first=await rawMutation('add_project_member_by_identifier',deniedArgs,quotaId);
      const attempts=(await env.db.query('select attempts from private.member_identifier_limits where user_id=$1',[user])).rows[0].attempts;
      const replay=await rawMutation('add_project_member_by_identifier',deniedArgs,quotaId);
      assert.equal(first.status,429);assert.equal(replay.status,429);assert.deepEqual(replay.body,first.body);assert.equal(replay.body.code,'PT429');
      assert.equal((await env.db.query('select attempts from private.member_identifier_limits where user_id=$1',[user])).rows[0].attempts,attempts);
      if(!upgrade){assert(/^\d+$/.test(first.headers.get('retry-after')));assert(Number(replay.headers.get('retry-after'))<=Number(first.headers.get('retry-after')));}
    }finally{await env.db.query('update private.member_identifier_limits set attempts=1 where user_id=$1',[user]);}
  });
  await check('B04 target changes reject pages; retention cannot lower the revision',async()=>{
    const first=await value(client.rpc('get_task_item_snapshot_page',{p_task_id:task}));
    await value(mutation('archive_task_item',{p_task_item_id:first.rows[0].id}));
    assert.equal((await client.rpc('get_task_item_snapshot_page',{p_task_id:task,p_offset:500,p_revision:first.revision})).error?.code,'PT409');
    const changed=await value(client.rpc('get_task_item_snapshot_page',{p_task_id:task}));
    await env.db.query('delete from private.task_item_sync_changes where task_id=$1',[task]);
    const retained=await value(client.rpc('get_task_item_snapshot_page',{p_task_id:task,p_revision:changed.revision}));
    assert.equal(retained.revision,changed.revision); assert.equal(retained.total,501);
    assert.equal((await value(client.rpc('get_task_item_snapshot_page',{p_task_id:task,p_mode:'active'}))).total,500);
    assert.equal((await api.client(other).rpc('get_task_item_snapshot_page',{p_task_id:task})).error?.code,'42501');
  });
  await check('P02 fingerprint preserves JSONB equality, ordering and null semantics',async()=>{
    const hash=async payload=>(await env.db.query("select private.receipt_request_hash('test',$1,$2::jsonb) h",[task,payload])).rows[0].h;
    assert.deepEqual(await hash('{"n":1,"nested":[1.00,{"x":0.000}]}'),await hash('{"nested":[1,{"x":0}],"n":1.000}'));
    assert.notDeepEqual(await hash('{}'),await hash('{"x":null}'));
    assert.notDeepEqual(await hash('[1,2]'),await hash('[2,1]'));
    assert.equal((await env.db.query('select count(*)::int n from private.client_operation_receipts where request_payload is not null or octet_length(request_fingerprint)<>32')).rows[0].n,0);
  });
  const budget=async()=>(await env.db.query('select receipt_count,logical_bytes from private.client_operation_budgets where user_id=$1',[user])).rows[0];
  await check('B01 + P02 full/unconfigured budgets replay compacted denial, reject new work',async()=>{
    const before=await budget();
    try {
      await env.db.query('update private.client_operation_policy set max_receipts=$1',[before.receipt_count]);
      assert.equal((await mutation('add_project_member_by_identifier',deniedArgs,deniedId)).status,400);
      const limited=await mutation('create_project',{p_name:'Must not exist'});assert.equal(limited.error?.code,'PT507');
      assert.equal((await env.db.query("select count(*)::int n from public.projects where name='Must not exist'")).rows[0].n,0);
      assert.deepEqual(await budget(),before);
      await env.db.query('update private.client_operation_policy set max_receipts=null');
      assert.equal((await mutation('add_project_member_by_identifier',deniedArgs,deniedId)).status,400);
      assert.equal((await mutation('create_project',{p_name:'Unconfigured'})).error?.details,'TT_RECEIPT_POLICY');
      assert.equal((await mutation('add_project_member_by_identifier',{...deniedArgs,p_identifier:'changed@invalid.test'},deniedId)).error?.code,'22023');
    } finally { env.sql(receiptTestPolicySql); }
  });
  await check('P02 oversized result rolls business effects and reservation back together',async()=>{
    const before=await budget();
    try{
      await env.db.query('update private.client_operation_policy set max_result_bytes=16');
      assert.equal((await mutation('create_project',{p_name:'Rolled back result'})).error?.code,'PT507');
      assert.equal((await env.db.query("select count(*)::int n from public.projects where name='Rolled back result'")).rows[0].n,0);
      assert.deepEqual(await budget(),before);
    }finally{env.sql(receiptTestPolicySql);}
  });
  await check('P02 byte capacity rejects before business work and completed receipts stay immutable',async()=>{
    const before=await budget();
    try{
      await env.db.query('update private.client_operation_policy set max_logical_bytes=$1',[before.logical_bytes]);
      assert.equal((await mutation('create_project',{p_name:'Byte budget rejected'})).error?.code,'PT507');
      assert.equal((await mutation('add_project_member_by_identifier',deniedArgs,deniedId)).status,400);
      assert.equal((await env.db.query("select count(*)::int n from public.projects where name='Byte budget rejected'")).rows[0].n,0);
      assert.deepEqual(await budget(),before);
      await assert.rejects(env.db.query('delete from private.client_operation_receipts where user_id=$1 and operation_id=$2',[user,deniedId]),{code:'22023'});
      await assert.rejects(env.db.query("update private.client_operation_receipts set result_payload='{}' where user_id=$1 and operation_id=$2",[user,deniedId]),{code:'22023'});
      assert.deepEqual(await budget(),before);
    }finally{env.sql(receiptTestPolicySql);}
  });
  await check('P02 last budget slot is atomic for concurrent independent and identical IDs',async()=>{
    const before=await budget();
    try{
      await env.db.query('update private.client_operation_policy set max_receipts=$1',[Number(before.receipt_count)+1]);
      const results=await Promise.all(['First slot','Second slot'].map(p_name=>mutation('create_project',{p_name})));
      assert.equal(results.filter(r=>!r.error).length,1);assert.equal(results.filter(r=>r.error?.code==='PT507').length,1);
      assert.equal(Number((await budget()).receipt_count),Number(before.receipt_count)+1);
    }finally{env.sql(receiptTestPolicySql);}
    const id=randomUUID(),args={p_name:'One concurrent creation'};
    const results=await Promise.all([mutation('create_project',args,id),mutation('create_project',args,id)]);
    assert.equal(results[0].error,null);assert.equal(results[1].error,null);assert.equal(results[0].data,results[1].data);
  });
  await check('P02 CAS conflict releases receipt count and bytes; rate/input limits are distinct',async()=>{
    const item=await value(mutation('create_task_item',{p_task_id:foreign,p_title:'CAS quota'}));const before=await budget();
    const conflict=await value(client.rpc('apply_task_item_percentage_operation_v2',{p_operation_id:randomUUID(),p_task_item_id:item,p_expected_version:999,p_percentage:60}));
    assert.equal(conflict.status,'conflict');assert.deepEqual(await budget(),before);
    try{
      await env.db.query('update private.client_operation_policy set max_request_bytes=1');
      assert.equal((await mutation('create_project',{p_name:'Too large'})).error?.code,'PT413');
      env.sql(receiptTestPolicySql);await env.db.query('update private.client_operation_policy set new_per_minute=1');
      assert.equal((await mutation('create_project',{p_name:'Rate'})).error?.details,'TT_RECEIPT_RATE');
      assert.deepEqual(await budget(),before);
    }finally{env.sql(receiptTestPolicySql);}
  });
  if (failures.length) throw Error(failures.length+' failed: '+failures.join(', '));
  console.log(`PASS audit fixes integration: ${passed} scenarios`);
} finally { api?.close(); await env.close(); }
