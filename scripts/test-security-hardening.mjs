import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {createSecurityDatabase,asUser,root} from './security-test-harness.mjs';
import {startSecurityApi} from './security-test-api.mjs';
import {restoreHostedSecurityFixture} from './security-hosted-fixture.mjs';
import {verifyReceiptAndAccessRaces} from './security-receipt-races.mjs';
const output=process.env.TASKTRACE_SECURITY_EVIDENCE||root+'/.expo/security-evidence';
mkdirSync(output,{recursive:true});
const checks=[],coverage=[];
const pass=(name,kind='adversarial')=>checks.push({name,kind});
const env=await createSecurityDatabase({baselineOnly:process.argv.includes('--hosted')});
let api;
try{
 if(process.argv.includes('--hosted')){
  await restoreHostedSecurityFixture(env);
  for(const file of readdirSync(root+'/supabase/migrations').filter(n=>n.endsWith('.sql')&&n>='20261016191158_').sort())
   env.sql('set role postgres;set search_path=public,extensions;\n'+readFileSync(root+'/supabase/migrations/'+file,'utf8'));
 }
 api=await startSecurityApi(env);
 const ids=Array.from({length:7},()=>randomUUID());
 const [owner,otherOwner,admin,member,viewer,override,outsider]=ids;
 for(const [i,id]of ids.entries())await env.db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)",[id,id+'@security.test',JSON.stringify({display_name:'Security User '+i})]);
 const clients=Object.fromEntries(ids.map(id=>[id,api.client(id)])),anon=api.client(),service=api.client(null,'service_role');
 async function fixture(){
  return asUser(env.db,owner,async()=>{
   const scalar=async(q,p=[])=>(await env.db.query(q,p)).rows[0].id;
   const project=await scalar("select public.create_project('Private project A') id");
   for(const [id,role]of [[admin,'admin'],[member,'member'],[viewer,'viewer'],[override,'viewer']])
    await env.db.query('select public.add_project_member($1,$2,$3)',[project,id,role]);
   const task=await scalar("select public.create_task($1,'Private stage A') id",[project]);
   const item=await scalar("select public.create_task_item($1,'Private checklist A') id",[task]);
   const archivedItem=await scalar("select public.create_task_item($1,'Archived item') id",[task]);
   await env.db.query('select public.archive_task_item($1)',[archivedItem]);
   const archivedTask=await scalar("select public.create_task($1,'Archived stage') id",[project]);
   await env.db.query('select public.archive_task($1)',[archivedTask]);
   await env.db.query("select public.set_task_member_override($1,$2,'admin')",[task,override]);
   await env.db.query("select public.set_task_member_override($1,$2,'member')",[task,viewer]);
   await env.db.query('select public.add_task_assignee($1,$2)',[task,member]);
   const template=await scalar("select public.create_task_template('Global template A') id"),templateItems=[];
   for(const title of ['Template A','Template B','Template C'])templateItems.push(await scalar('select public.create_task_template_item($1,$2) id',[template,title]));
   const archivedProject=await scalar("select public.create_project('Archived project A') id");
   for(const [id,role]of [[admin,'admin'],[member,'member'],[viewer,'viewer']])await env.db.query('select public.add_project_member($1,$2,$3)',[archivedProject,id,role]);
   await env.db.query('select public.archive_project($1)',[archivedProject]);
   return{project,task,item,archivedItem,archivedTask,template,templateItem:templateItems[1],archivedProject};
  });
 }
 const foreign=await asUser(env.db,otherOwner,async()=>{
  const project=(await env.db.query("select public.create_project('Private project B') id")).rows[0].id;
  const task=(await env.db.query("select public.create_task($1,'Foreign stage') id",[project])).rows[0].id;
  const item=(await env.db.query("select public.create_task_item($1,'Foreign item') id",[task])).rows[0].id;
  const template=(await env.db.query("select public.create_task_template('Global template B') id")).rows[0].id;
  const templateItem=(await env.db.query("select public.create_task_template_item($1,'Foreign creator item') id",[template])).rows[0].id;
  return{project,task,item,template,templateItem};
 });
 const cases={
 add_project_member:f=>({p_project_id:f.project,p_user_id:outsider,p_role:'member'}),
 add_project_member_by_identifier:f=>({p_project_id:f.project,p_identifier:outsider+'@security.test',p_role:'member'}),
 add_task_assignee:f=>({p_task_id:f.task,p_user_id:override}),
 apply_task_item_comment_operation:f=>({p_operation_id:randomUUID(),p_task_item_id:f.item,p_comment:'accepted'}),
 apply_task_item_comment_operation_v2:f=>({p_operation_id:randomUUID(),p_task_item_id:f.item,p_expected_version:1,p_comment:'accepted'}),
 apply_task_item_percentage_operation:f=>({p_operation_id:randomUUID(),p_task_item_id:f.item,p_percentage:40}),
 apply_task_item_percentage_operation_v2:f=>({p_operation_id:randomUUID(),p_task_item_id:f.item,p_expected_version:1,p_percentage:40}),
 apply_task_item_state_operation:f=>({p_operation_id:randomUUID(),p_task_item_id:f.item,p_completed:true}),
 apply_task_item_state_operation_v2:f=>({p_operation_id:randomUUID(),p_task_item_id:f.item,p_expected_version:1,p_completed:true}),
 archive_project:f=>({p_project_id:f.project}),archive_task:f=>({p_task_id:f.task}),
 archive_task_item:f=>({p_task_item_id:f.item}),archive_task_template:f=>({p_template_id:f.template}),
 change_member_role:f=>({p_project_id:f.project,p_user_id:member,p_new_role:'viewer'}),
 clear_task_member_override:f=>({p_task_id:f.task,p_user_id:viewer}),
 create_project:()=>({p_name:'New private project'}),create_task:f=>({p_project_id:f.project,p_title:'New stage'}),
 create_task_from_template:f=>({p_project_id:f.project,p_template_id:f.template}),
 create_task_item:f=>({p_task_id:f.task,p_title:'New checklist'}),create_task_template:()=>({p_name:'New global template'}),
 create_task_template_item:f=>({p_template_id:f.template,p_title:'New template item'}),
 delete_task_template_item:f=>({p_item_id:f.templateItem}),get_my_profile:()=>({}),get_my_task_role:f=>({p_task_id:f.task}),
 get_offline_runtime_config:()=>({}),get_task_item_sync_cursor:()=>({}),get_task_template:f=>({p_template_id:f.template}),
 hard_delete_project:f=>({p_project_id:f.archivedProject}),hard_delete_task:f=>({p_task_id:f.archivedTask}),
 hard_delete_task_item:f=>({p_task_item_id:f.archivedItem}),list_task_item_last_editors:f=>({p_task_id:f.task}),
 list_task_member_overrides:f=>({p_task_id:f.task}),list_task_template_items:f=>({p_template_id:f.template}),list_task_templates:()=>({}),
 mark_all_notifications_read:()=>({}),mark_notification_read:f=>({p_notification_id:f.notification}),
 move_task:f=>({p_task_id:f.task,p_direction:1}),move_task_template_item:f=>({p_item_id:f.templateItem,p_direction:-1}),
 pull_task_item_changes:()=>({p_after_cursor:0,p_limit:100}),pull_task_item_changes_v2:()=>({p_after_cursor:0,p_limit:100}),
 remove_project_member:f=>({p_project_id:f.project,p_user_id:member}),remove_task_assignee:f=>({p_task_id:f.task,p_user_id:member}),
 restore_project:f=>({p_project_id:f.archivedProject}),restore_task:f=>({p_task_id:f.archivedTask}),
 set_task_item_comment:f=>({p_task_item_id:f.item,p_comment:'accepted',p_expected_version:1}),
 set_task_item_deadline:f=>({p_task_item_id:f.item,p_expected_version:1,p_deadline_at:new Date(Date.now()+86400000).toISOString()}),
 set_task_item_percentage:f=>({p_task_item_id:f.item,p_percentage:40,p_expected_version:1}),
 set_task_item_progress:f=>({p_task_item_id:f.item,p_completion_percent:40}),
 set_task_item_state:f=>({p_task_item_id:f.item,p_completed:true,p_expected_version:1}),set_task_member_override:f=>({p_task_id:f.task,p_user_id:member,p_role:'viewer'}),
 transfer_project_ownership:f=>({p_project_id:f.project,p_new_owner_id:member}),update_my_profile:()=>({p_display_name:'Updated Security Owner',p_expected_display_name:'Security Owner'}),
 update_project:f=>({p_project_id:f.project,p_name:'Updated project',p_description:'Updated description',p_expected_name:'Project A',p_expected_description:''}),
 update_task:f=>({p_task_id:f.task,p_title:'Updated stage',p_description:'',p_expected_title:'Stage A',p_expected_description:''}),update_task_item:f=>({p_task_item_id:f.item,p_title:'Updated item',p_expected_version:1}),
 update_task_template:f=>({p_template_id:f.template,p_name:'Updated template',p_description:'',p_expected_name:'Global template A',p_expected_description:''}),update_task_template_item:f=>({p_item_id:f.templateItem,p_title:'Updated template item',p_description:'',p_expected_title:'B',p_expected_description:''}),
 };
 const original=JSON.parse(readFileSync(root+'/supabase/tests/fixtures/hosted_security_baseline_20261016.json','utf8')).snapshot.functions.filter(f=>f.schema==='public'&&f.definer).map(f=>f.name).sort();
 assert.deepEqual(Object.keys(cases).sort(),original);
 const readable=new Set(['get_my_profile','get_my_task_role','get_offline_runtime_config','get_task_item_sync_cursor','get_task_template','list_task_item_last_editors','list_task_template_items','list_task_templates','pull_task_item_changes','pull_task_item_changes_v2']);
 const ownScope=new Set(['create_project','create_task_template','get_my_profile','update_my_profile','mark_all_notifications_read','mark_notification_read','get_offline_runtime_config','get_task_item_sync_cursor','get_task_template','list_task_item_last_editors','list_task_template_items','list_task_templates','pull_task_item_changes','pull_task_item_changes_v2']);
 // Include every mutation side-effect store; quota is intentionally separate.
 const stores={profiles:'id',projects:'id',project_members:'project_id,user_id',tasks:'id',task_items:'id',task_members:'task_id,user_id',task_assignees:'task_id,user_id',task_templates:'id',task_template_items:'id',audit_log:'id',item_actions:'id',notifications:'id'};
 const subqueries=Object.entries(stores).map(([table,order])=>'(select jsonb_agg(to_jsonb(t) order by '+order+') from public.'+table+' t)');
 subqueries.push('(select jsonb_agg(to_jsonb(t) order by user_id,operation_id) from private.client_operation_receipts t)','(select jsonb_agg(to_jsonb(t) order by cursor) from private.task_item_sync_changes t)');
 subqueries.push('(select jsonb_agg(to_jsonb(t) order by item_id) from private.checklist_deadline_state t)',
  '(select jsonb_agg(to_jsonb(t) order by singleton) from private.offline_runtime_config t)',
  '(select jsonb_agg(to_jsonb(t) order by singleton) from private.task_item_sync_retention t)',
  '(select jsonb_agg(to_jsonb(t) order by id) from auth.users t)');
 async function business(){return(await env.db.query('select md5(jsonb_build_array('+subqueries.join(',')+')::text) as hash')).rows[0].hash;}
 async function denied(label,client,name,args){
  const before=await business(),r=await client.rpc(name,args);
  assert(r.error,label+': expected denial, got '+JSON.stringify(r.data));
  assert.equal(await business(),before,label+': business side effect');pass(label);return r;
 }
 const archived=await fixture();
 await asUser(env.db,owner,()=>env.db.query('select public.archive_task_template($1)',[archived.template]));
 const archivedReads=new Set(['get_my_task_role','get_task_template','list_task_item_last_editors','list_task_member_overrides','list_task_template_items']);
 const archivedNoops=new Set(['archive_project','archive_task','archive_task_item']);
 for(const name of original){
  const f=await fixture();
  f.notification=(await env.db.query("insert into public.notifications(user_id,project_id,task_id,type,title,body,data,dedupe_key) values($1,$2,$3,'task_item_changed','Private notice','Private body','{}',$4) returning id",[owner,f.project,f.task,randomUUID()])).rows[0].id;
  const args=cases[name](f);
  // Capture each fixture's actual baseline; do not bypass CAS or ACL checks.
  if(name==='update_project'){const r=(await env.db.query('select name,description from public.projects where id=$1',[f.project])).rows[0];args.p_expected_name=r.name;args.p_expected_description=r.description??'';}
  if(name==='update_task'){const r=(await env.db.query('select title,description from public.tasks where id=$1',[f.task])).rows[0];args.p_expected_title=r.title;args.p_expected_description=r.description??'';}
  if(name==='update_task_template'){const r=(await env.db.query('select name,description from public.task_templates where id=$1',[f.template])).rows[0];args.p_expected_name=r.name;args.p_expected_description=r.description??'';}
  if(name==='update_task_template_item'){const r=(await env.db.query('select title,description from public.task_template_items where id=$1',[f.templateItem])).rows[0];args.p_expected_title=r.title;args.p_expected_description=r.description??'';}
  if(name==='update_my_profile')args.p_expected_display_name=(await env.db.query('select display_name from public.profiles where id=$1',[owner])).rows[0].display_name;
  if(name.startsWith('apply_task_item_')&&!name.endsWith('_v2')||name==='set_task_item_progress'){
   for(const id of [owner,admin,member,viewer,outsider])assert.equal((await denied(name+': retired contract requires upgrade',clients[id],name,args)).error.code,'PT426');
   await denied(name+': anonymous',anon,name,args);await denied(name+': service_role',service,name,args);
  }
  await denied(name+': anonymous',anon,name,args);
  await denied(name+': service_role',service,name,args);
  await denied(name+': forged actor argument',clients[owner],name,{...args,p_actor:owner});
  const malformedBefore=await business();
  const malformed=await fetch(api.url+'/rpc/'+name,{method:'POST',headers:{Authorization:'Bearer '+api.token(owner),'Content-Type':'application/json'},body:'{]'});
  assert.equal(malformed.status,400);assert.equal(await business(),malformedBefore);pass(name+': malformed JSON cannot execute');
  if(!ownScope.has(name))await denied(name+': outsider',clients[outsider],name,args);
  else{
   const ownArgs=name==='update_my_profile'?{...args,p_expected_display_name:(await env.db.query('select display_name from public.profiles where id=$1',[outsider])).rows[0].display_name}:args;
   const r=await clients[outsider].rpc(name,ownArgs);
   assert(!r.error,name+': self/global scope should remain usable');
   if(name==='get_my_profile')assert.equal(r.data.id,outsider);
   if(name==='list_task_item_last_editors')assert.deepEqual(r.data,[]);
   if(name.startsWith('pull_'))assert(!r.data.changes.some(c=>c.task_id===f.task||c.task_item_id===f.item));
   pass(name+': self/global contract preserved');
  }
  // For progress a project viewer can be explicitly overridden; use an
  // independent actual viewer (override cleared) for this negative case.
  await asUser(env.db,owner,()=>env.db.query('select public.clear_task_member_override($1,$2)',[f.task,viewer]));
  if(!readable.has(name)&&!ownScope.has(name))await denied(name+': insufficient viewer',clients[viewer],name,args);
  else if(name==='get_my_task_role')assert.equal((await clients[viewer].rpc(name,args)).data,'viewer');
  if(Object.keys(args).length){
   const nullArgs=Object.fromEntries(Object.keys(args).map(k=>[k,null])),before=await business(),r=await clients[owner].rpc(name,nullArgs);
   assert.equal(await business(),before,name+': NULL arguments changed state');
   assert(r.error||r.data===null||Array.isArray(r.data)&&r.data.length===0,name+': unsafe NULL result');pass(name+': NULL safe');
  }
  const foreignArgs={...args};
  for(const key of Object.keys(foreignArgs)){
   if(key==='p_project_id')foreignArgs[key]=foreign.project;
   if(key==='p_task_id')foreignArgs[key]=foreign.task;
   if(key==='p_task_item_id')foreignArgs[key]=foreign.item;
   if(key==='p_template_id')foreignArgs[key]=foreign.template;
   if(key==='p_item_id')foreignArgs[key]=foreign.templateItem;
  }
  if(JSON.stringify(args)!==JSON.stringify(foreignArgs)&&!['get_task_template','list_task_template_items','list_task_item_last_editors'].includes(name))
   await denied(name+': foreign UUID',clients[owner],name,foreignArgs);
  if(!name.startsWith('restore_')&&!name.startsWith('hard_delete_')) {
   const archivedArgs={...args};
   const replacements={p_project_id:archived.archivedProject,p_task_id:archived.archivedTask,p_task_item_id:archived.archivedItem,p_template_id:archived.template,p_item_id:archived.templateItem};
   for(const key of Object.keys(archivedArgs))if(replacements[key])archivedArgs[key]=replacements[key];
   if(JSON.stringify(archivedArgs)!==JSON.stringify(args)){
    const before=await business(),result=await clients[owner].rpc(name,archivedArgs);
    if(archivedReads.has(name)||archivedNoops.has(name))assert(!result.error,name+': archived read/no-op contract failed');
    else assert(result.error,name+': archived mutation allowed');
    assert.equal(await business(),before,name+': archived read/denial changed state');pass(name+': archived state contract');
   }
  } else {
   // The normal positive call already targets an archived object. Also test
   // the inverse state; restore is idempotent, hard delete requires archive.
   const active={...args};
   if('p_project_id'in active)active.p_project_id=f.project;
   if('p_task_id'in active)active.p_task_id=f.task;
   if('p_task_item_id'in active)active.p_task_item_id=f.item;
   const before=await business(),result=await clients[owner].rpc(name,active);
   if(name.startsWith('hard_delete_'))assert(result.error,name+': active object hard-deleted');
   assert.equal(await business(),before,name+': incorrect lifecycle changed state');pass(name+': active/archived inverse state');
  }
  const concurrent=await Promise.all([clients[owner].rpc(name,args),clients[owner].rpc(name,args)]);
  const retired=name.startsWith('apply_task_item_')&&!name.endsWith('_v2')||name==='set_task_item_progress';
  if(retired)assert(concurrent.every(result=>result.error?.code==='PT426'),name+': retired concurrent write must require upgrade');
  else{
   assert(concurrent.some(result=>!result.error),name+': authorized concurrent calls failed '+JSON.stringify(concurrent));
   for(const result of concurrent)if(result.error)assert(['P0001','42501','PT409','TT_MEMBER_LOOKUP'].includes(result.error.code),name+': unexpected concurrency failure '+JSON.stringify(result.error));
  }
  pass(name+': two concurrent authorized requests','concurrency');
  coverage.push(name);pass(name+': authorized','rpc');
  if(coverage.length%10===0)console.log('RPC matrix progress '+coverage.length+'/57');
 }
 console.log('PASS original RPC matrix: '+coverage.length+' RPCs, '+checks.length+' scenarios');
 const direct=[['profiles','id',otherOwner],['projects','id',foreign.project],['tasks','id',foreign.task],['task_items','id',foreign.item],
  ['project_members','project_id',foreign.project],['task_members','task_id',foreign.task],['task_assignees','task_id',foreign.task],
  ['audit_log','project_id',foreign.project],['item_actions','project_id',foreign.project],['notifications','user_id',otherOwner],['checklist_overview','id',foreign.item]];
 for(const [table,column,id]of direct){
  const before=await business(),r=await clients[owner].from(table).select('*').eq(column,id);
  assert(!r.error,table+': direct SELECT failed '+JSON.stringify(r.error));assert.deepEqual(r.data,[],table+': foreign rows exposed');
  assert.equal(await business(),before);pass(table+': foreign rows hidden by real Data API RLS');
 }
 for(const table of Object.keys(stores)){
  const before=await business();
  assert((await anon.from(table).select('*').limit(1)).error,table+': anonymous read allowed');
  const column=['audit_log','item_actions'].includes(table)?'project_id':stores[table].split(',')[0];
  for(const request of [clients[owner].from(table).insert({}),clients[owner].from(table).update({[column]:null}).not(column,'is',null),clients[owner].from(table).delete().not(column,'is',null)]){
   const r=await request;assert.equal(r.error?.code,'42501',table+': direct DML not blocked by ACL '+JSON.stringify(r.error));
  }
  assert.equal(await business(),before);pass(table+': anonymous reads and direct INSERT/UPDATE/DELETE denied');
 }
 for(const table of ['task_templates','task_template_items']){
  assert((await clients[owner].from(table).select('*').limit(1)).error);pass(table+': RPC-only table SELECT denied');
 }
 for(const table of ['checklist_deadline_state','client_operation_receipts','offline_runtime_config','task_item_sync_changes','task_item_sync_retention','member_identifier_limits']){
  const r=await clients[owner].schema('private').from(table).select('*');assert.equal(r.error?.code,'PGRST106');pass(table+': private schema is not exposed');
 }
 const hierarchy=await fixture();
 for(const [name,args]of [
  ['change_member_role',{p_project_id:hierarchy.project,p_user_id:admin,p_new_role:'member'}],
  ['set_task_member_override',{p_task_id:hierarchy.task,p_user_id:admin,p_role:'viewer'}],
  ['clear_task_member_override',{p_task_id:hierarchy.task,p_user_id:admin}],
  ['change_member_role',{p_project_id:hierarchy.project,p_user_id:member,p_new_role:'admin'}]
 ])await denied(name+': self-change or self-escalation',clients[args.p_user_id],name,args);
 await env.db.query('truncate private.member_identifier_limits');
 const lookup=await fixture(),lookupB=await fixture(),lookupArgs={p_project_id:lookup.project,p_identifier:'absent@security.test',p_role:'member'};
 for(const patch of [{p_identifier:''},{p_identifier:'   '},{p_identifier:'x'.repeat(321)},{p_role:null},{p_role:'owner'},{p_project_id:null}]){
  const r=await denied('lookup rejects invalid bounded input '+JSON.stringify(patch),clients[owner],'add_project_member_by_identifier',{...lookupArgs,...patch});
  assert.equal(r.error.code,'22023');
 }
 assert.equal((await env.db.query('select count(*)::int n from private.member_identifier_limits')).rows[0].n,0);
 for(const id of [admin,viewer])await asUser(env.db,id,()=>env.db.query("select public.update_my_profile('Duplicate Security Name',(select display_name from public.profiles where id=auth.uid()))"));
 const failures=[];
 for(const p_identifier of ['absent@security.test',member+'@security.test','Duplicate Security Name']){
  const before=await business(),r=await clients[owner].rpc('add_project_member_by_identifier',{...lookupArgs,p_identifier});
  assert.equal(r.status,400);assert.equal(r.error?.code,'TT_MEMBER_LOOKUP');assert.equal(await business(),before);failures.push(r.error);
 }
 assert.deepEqual(failures[0],failures[1]);assert.deepEqual(failures[0],failures[2]);pass('not-found, existing member and ambiguous name have identical HTTP errors and no business side effects');
 await env.db.query('truncate private.member_identifier_limits');
 const baseline=await business();
 for(let i=0;i<20;i++){const r=await clients[owner].rpc('add_project_member_by_identifier',lookupArgs);assert.equal(r.status,400);assert.equal(r.error?.code,'TT_MEMBER_LOOKUP');}
 const limited=await clients[owner].rpc('add_project_member_by_identifier',{...lookupArgs,p_identifier:outsider+'@security.test'});
 assert.equal(limited.status,429);assert.equal(limited.error?.code,'PT429');
 assert.equal((await env.db.query('select attempts from private.member_identifier_limits where user_id=$1',[owner])).rows[0].attempts,21);
 assert.equal(await business(),baseline);pass('failed HTTP lookups persist quota; SDK recognizes 429; business stores unchanged');
 const bypass=await fetch(api.url+'/rpc/add_project_member_by_identifier',{method:'POST',headers:{Authorization:'Bearer '+api.token(owner),'Content-Type':'application/json',Prefer:'tx=rollback'},body:JSON.stringify(lookupArgs)});
 assert.equal(bypass.status,429);assert.equal((await env.db.query('select attempts from private.member_identifier_limits where user_id=$1',[owner])).rows[0].attempts,21);
 assert(Number(bypass.headers.get('retry-after'))>=1&&Number(bypass.headers.get('retry-after'))<=60);
 pass('client tx=rollback preference cannot bypass quota');
 await env.db.query("update private.member_identifier_limits set window_start=now()-interval '2 minutes' where user_id=$1",[owner]);
 assert.equal((await clients[owner].rpc('add_project_member_by_identifier',lookupArgs)).status,400);
 assert.equal((await env.db.query('select attempts from private.member_identifier_limits where user_id=$1',[owner])).rows[0].attempts,1);pass('quota expires');
 await env.db.query('truncate private.member_identifier_limits');
 const parallel=await Promise.all(Array.from({length:25},(_,i)=>clients[owner].rpc('add_project_member_by_identifier',{...lookupArgs,p_project_id:i%2?lookup.project:lookupB.project})));
 assert.equal(parallel.filter(r=>r.status===400).length,20);assert.equal(parallel.filter(r=>r.status===429).length,5);
 assert.equal(await business(),baseline);pass('parallel lookup quota cannot be overspent across different projects','concurrency');
 assert.equal((await clients[admin].rpc('add_project_member_by_identifier',lookupArgs)).status,400);
 assert.equal((await env.db.query('select attempts from private.member_identifier_limits where user_id=$1',[admin])).rows[0].attempts,1);
 assert.equal(await business(),baseline);pass('an independent actor has a separate quota');
 await env.db.query('truncate private.member_identifier_limits');
 const added=await clients[owner].rpc('add_project_member_by_identifier',{...lookupArgs,p_project_id:lookupB.project,p_identifier:'  '+(outsider+'@security.test').toUpperCase()+'  '});
 assert.equal(added.error,null);assert.deepEqual(added.data,{success:true});
 assert.equal((await env.db.query('select role from public.project_members where project_id=$1 and user_id=$2',[lookupB.project,outsider])).rows[0].role,'member');
 pass('valid email lookup trims/case-normalizes and preserves the membership success contract');
 console.log('PASS committed lookup quota, window reset, parallel requests');
 await verifyReceiptAndAccessRaces({env,api,ids,fixture,business,pass});
 writeFileSync(output+'/security-api-results'+(process.argv.includes('--hosted')?'-hosted':'-fresh')+'.json',JSON.stringify({coverage,checks,counts:{rpc:coverage.length,scenarios:checks.length,concurrency:checks.filter(c=>c.kind==='concurrency').length}},null,2));
}finally{api?.close();await env.close();}
