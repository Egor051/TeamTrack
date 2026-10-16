import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connect,asUser} from './security-test-harness.mjs';
export async function verifyReceiptAndAccessRaces({env,api,ids,fixture,business,pass}){
 const [owner,,admin,member,,,outsider]=ids;
 const user=api.client(member),manager=api.client(owner),other=api.client(outsider);
 const value=async p=>{const r=await p;if(r.error)throw Error(JSON.stringify(r.error));return r.data;};
 const count=async(table,where,params)=>(await env.db.query('select count(*)::int n from '+table+' where '+where,params)).rows[0].n;
 for(const state of ['revoke','downgrade','archive','delete']){
  const f=await fixture(),args={p_operation_id:randomUUID(),p_task_item_id:f.item,p_expected_version:1,p_comment:'Original accepted comment'};
  const original=await value(user.rpc('apply_task_item_comment_operation_v2',args));
  await value(manager.rpc('set_task_item_comment',{p_task_item_id:f.item,p_comment:'New private server content'}));
  if(state==='revoke')await value(manager.rpc('remove_project_member',{p_project_id:f.project,p_user_id:member}));
  if(state==='downgrade')await value(manager.rpc('change_member_role',{p_project_id:f.project,p_user_id:member,p_new_role:'viewer'}));
  if(state==='archive')await value(manager.rpc('archive_task_item',{p_task_item_id:f.item}));
  if(state==='delete'){await value(manager.rpc('archive_task_item',{p_task_item_id:f.item}));await value(manager.rpc('hard_delete_task_item',{p_task_item_id:f.item}));}
  const before=await business();
  assert.deepEqual(await value(user.rpc('apply_task_item_comment_operation_v2',args)),original,'ACK changed after '+state);
  assert.equal(await business(),before,'duplicate ACK mutated state after '+state);
  const version=(await env.db.query('select sync_version from public.task_items where id=$1',[f.item])).rows[0]?.sync_version??3;
  const denied=await user.rpc('apply_task_item_comment_operation_v2',{...args,p_operation_id:randomUUID(),p_expected_version:version,p_comment:'Unauthorized new write'});
  assert.equal(denied.error?.code,'42501');assert.equal(await business(),before);
  const mismatch=await user.rpc('apply_task_item_comment_operation_v2',{...args,p_comment:'Changed replay payload'});
  assert.equal(mismatch.error?.code,'22023');assert.equal(await business(),before);
  const foreign=await other.rpc('apply_task_item_comment_operation_v2',args);
  assert.equal(foreign.error?.code,'42501');
  assert.equal(await count('private.client_operation_receipts','user_id=$1 and operation_id=$2',[outsider,args.p_operation_id]),0);
  assert.equal(await business(),before);
  if(state==='revoke'){
   const pull=await value(user.rpc('pull_task_item_changes_v2',{p_after_cursor:0,p_limit:500}));
   assert(!pull.changes.some(c=>c.task_id===f.task));
  }
  pass('ACK after '+state+': historical own response only; new/mismatched/foreign operation rejected');
 }
 for(const version of [1,2])for(const kind of ['comment','percentage','state']){
  const f=await fixture(),name='apply_task_item_'+kind+'_operation'+(version===2?'_v2':'');
  const args={p_operation_id:randomUUID(),p_task_item_id:f.item,...(version===2?{p_expected_version:1}:{}),
   ...(kind==='comment'?{p_comment:'Concurrent accepted'}:kind==='percentage'?{p_percentage:65}:{p_completed:true})};
  const before=await count('public.audit_log',"entity_type='task_item' and entity_id=$1",[f.item]);
  const beforeFeed=await count('private.task_item_sync_changes','task_item_id=$1',[f.item]);
  const beforeActions=await count('public.item_actions','task_item_id=$1',[f.item]);
  const beforeNotices=await count('public.notifications',"data->>'entity_id'=$1",[f.item]);
  const results=await Promise.all([value(user.rpc(name,args)),value(user.rpc(name,args))]);
  assert.deepEqual(results[0],results[1]);
  assert.equal(await count('public.audit_log',"entity_type='task_item' and entity_id=$1",[f.item]),before+1);
  assert.equal(await count('private.task_item_sync_changes','task_item_id=$1',[f.item]),beforeFeed+1);
  assert.equal(await count('public.item_actions','task_item_id=$1',[f.item]),beforeActions+(kind==='state'?1:0));
  assert.equal(await count('public.notifications',"data->>'entity_id'=$1",[f.item]),beforeNotices+4);
  assert.equal(await count('private.client_operation_receipts','user_id=$1 and operation_id=$2',[member,args.p_operation_id]),1);
  pass(name+': concurrent duplicates have one receipt, audit, feed and notification fanout','concurrency');
 }
 const cas=await fixture();
 const competing=await Promise.all([65,70].map(p_percentage=>value(user.rpc('apply_task_item_percentage_operation_v2',{
  p_operation_id:randomUUID(),p_task_item_id:cas.item,p_expected_version:1,p_percentage}))));
 assert.deepEqual(competing.map(r=>r.status).sort(),['applied','conflict']);
 assert.equal(await count('private.client_operation_receipts','user_id=$1 and task_item_id=$2',[member,cas.item]),1);
 pass('two independent CAS operations: exactly one mutation and one conflict','concurrency');
 const blocker=connect(env.port,env.database,'security_blocker');
 try{
  await blocker.connect();
  for(const state of ['revoke','downgrade','archive','delete']){
   const f=await fixture();
   const beforeAudit=await count('public.audit_log',"entity_type='task_item' and entity_id=$1",[f.item]);
   await blocker.query('begin');await blocker.query('set local role authenticated');
   await blocker.query("select set_config('request.jwt.claim.sub',$1,true)",[owner]);
   if(state==='revoke')await blocker.query('select public.remove_project_member($1,$2)',[f.project,member]);
   if(state==='downgrade')await blocker.query("select public.change_member_role($1,$2,'viewer')",[f.project,member]);
   if(state==='archive')await blocker.query('select public.archive_project($1)',[f.project]);
   if(state==='delete'){await blocker.query('select public.archive_task_item($1)',[f.item]);await blocker.query('select public.hard_delete_task_item($1)',[f.item]);}
   const rpc=state==='delete'?'apply_task_item_comment_operation_v2':'set_task_item_comment';
   const request=user.rpc(rpc,{p_task_item_id:f.item,p_comment:'Must not commit',...(state==='delete'?{p_operation_id:randomUUID(),p_expected_version:1}:{})}).then(r=>r);
   let waiting=false;
   for(let i=0;i<200;i++){
    const r=await env.db.query("select 1 from pg_stat_activity where datname=$1 and state='active' and wait_event_type='Lock' and query like $2",[env.database,'%'+rpc+'%']);
    if(r.rowCount){waiting=true;break;}await new Promise(r=>setTimeout(r,25));
   }
   assert(waiting,'request did not reach project lock for '+state);
   await blocker.query('commit');
   const rejected=await request;
   assert(rejected.error,'write after '+state+' unexpectedly committed');assert.notEqual(rejected.error.code,'40P01');
   assert.equal((await env.db.query('select comment from public.task_items where id=$1',[f.item])).rows[0]?.comment??null,null);
   assert.equal(await count('public.audit_log',"entity_type='task_item' and entity_id=$1 and new_data->>'comment'='Must not commit'",[f.item]),0);
   if(state!=='delete')assert.equal(await count('public.audit_log',"entity_type='task_item' and entity_id=$1",[f.item]),beforeAudit);
   pass('waiting write vs committed '+state+': current permission/state rechecked','concurrency');
  }
 }finally{await blocker.query('rollback').catch(()=>undefined);await blocker.end();}
 const transfer=await fixture();
 const transfers=await Promise.all([member,admin].map(id=>manager.rpc('transfer_project_ownership',{p_project_id:transfer.project,p_new_owner_id:id})));
 assert.equal(transfers.filter(r=>!r.error).length,1);assert.equal(transfers.filter(r=>r.error?.code==='42501').length,1);
 assert.equal(await count('public.project_members',"project_id=$1 and role='owner'",[transfer.project]),1);
 pass('two ownership transfers: one current owner and one rejected stale owner','concurrency');
 console.log('PASS ACK lifecycle, exactly-once fanout, CAS, membership/archive/delete races and ownership serialization');
}
