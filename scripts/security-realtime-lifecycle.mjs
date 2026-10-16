import assert from 'node:assert/strict';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync,mkdirSync } from 'node:fs';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';
import { root } from './security-test-harness.mjs';

const local=getLocalSupabaseStatus();
if(local.kind!=='tasktrace-isolated-security-test')throw Error('Disposable stack required');
const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}};
const admin=createClient(local.API_URL,local.SERVICE_ROLE_KEY,options);
const [owner,member,foreign]=Array.from({length:3},()=>createClient(local.API_URL,local.ANON_KEY,options));
const clients=[owner,member,foreign,admin],users=[],projects=[],checks=[];
const db=new pg.Client({connectionString:local.DB_URL});
const value=async p=>{const r=await p;if(r.error)throw Error(JSON.stringify(r.error));return r.data;};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await pause(50);}throw Error('Realtime event timeout');}
async function channel(client,topic,allowed=true){
 const events=[],ch=client.channel(topic,{config:{private:true}});
 ch.on('broadcast',{event:'invalidate'},message=>events.push(message.payload));
 await new Promise((ok,no)=>{
  const timer=setTimeout(()=>no(Error('Realtime join timeout')),10000);
  ch.subscribe((status,error)=>{
   if(status==='SUBSCRIBED'){clearTimeout(timer);allowed?ok():no(Error('Unauthorized topic joined'));}
   if(status==='CHANNEL_ERROR'){clearTimeout(timer);allowed?no(error):ok();}
   if(status==='TIMED_OUT'){clearTimeout(timer);no(Error('Realtime join timed out'));}
  });
 });
 return {ch,events};
}
const minimal=payload=>{
 assert(Object.keys(payload).every(k=>['id','table','operation'].includes(k)));
 assert(['projects','project_members','tasks','task_items','task_members','task_assignees','notifications','profiles'].includes(payload.table));
 assert(['INSERT','UPDATE','DELETE'].includes(payload.operation));
};
try{
 await db.connect();
 for(const [i,client]of [owner,member,foreign].entries()){
  const email='realtime-security-'+Date.now()+'-'+i+'@security.test',password='RealtimeSafe9Z!';
  const created=await value(admin.auth.admin.createUser({email,password,email_confirm:true}));users.push(created.user.id);
  await value(client.auth.signInWithPassword({email,password}));
 }
 const a=await value(owner.rpc('create_project',{p_name:'Isolated Realtime A'}));projects.push([owner,a]);
 const b=await value(foreign.rpc('create_project',{p_name:'Isolated Realtime B'}));projects.push([foreign,b]);
 await value(owner.rpc('add_project_member',{p_project_id:a,p_user_id:users[1],p_role:'member'}));
 const task=await value(owner.rpc('create_task',{p_project_id:a,p_title:'Private stage'}));
 const item=await value(owner.rpc('create_task_item',{p_task_id:task,p_title:'Private item'}));
 const memberTopic=await channel(member,'project:'+a),foreignTopic=await channel(foreign,'project:'+b);
 const forbidden=await channel(member,'project:'+b,false);await member.removeChannel(forbidden.ch);
 const foreignUser=await channel(owner,'user:'+users[2],false);await owner.removeChannel(foreignUser.ch);
 checks.push('project and user topics enforce current membership/identity');
 await value(owner.rpc('update_task',{p_task_id:task,p_title:'First private title'}));
 await until(()=>memberTopic.events.length>0);memberTopic.events.forEach(minimal);
 await member.removeAllChannels();member.realtime.disconnect();member.realtime.connect();
 const reconnected=await channel(member,'project:'+a);
 await value(owner.rpc('update_task',{p_task_id:task,p_title:'After transport reconnect'}));
 await until(()=>reconnected.events.length>0);reconnected.events.forEach(minimal);
 checks.push('authorized reconnect/rejoin receives a new Broadcast');
 await value(owner.rpc('remove_project_member',{p_project_id:a,p_user_id:users[1]}));
 const before=(await db.query('select count(*)::int n from public.audit_log')).rows[0].n;
 assert.deepEqual(await value(member.from('tasks').select('*').eq('id',task)),[]);
 assert.equal((await member.rpc('set_task_item_percentage',{p_task_item_id:item,p_percentage:60})).error?.code,'42501');
 assert.equal((await db.query('select count(*)::int n from public.audit_log')).rows[0].n,before);
 const previous=reconnected.events.length;
 await value(owner.rpc('update_task',{p_task_id:task,p_title:'New inaccessible private content'}));await pause(1000);
 reconnected.events.forEach(minimal);
 const cachedAfterRevoke=reconnected.events.slice(previous).filter(p=>p.table==='tasks'&&p.operation==='UPDATE').length;
 await member.removeAllChannels();
 const revoked=await channel(member,'project:'+a,false);await member.removeChannel(revoked.ch);
 await value(member.auth.refreshSession());
 const refreshed=await channel(member,'project:'+a,false);await member.removeChannel(refreshed.ch);
 assert.deepEqual(foreignTopic.events,[]);
 checks.push('revoke immediately fences RLS/new writes; fresh/re-authenticated joins fail; foreign project gets no events');
 await value(owner.rpc('add_project_member',{p_project_id:a,p_user_id:users[1],p_role:'member'}));
 const restored=await channel(member,'project:'+a);
 await value(owner.rpc('update_task',{p_task_id:task,p_title:'Access restored'}));await until(()=>restored.events.length>0);
 assert.equal((await value(member.from('tasks').select('id').eq('id',task))).length,1);
 checks.push('restored membership can rejoin and read again');
 await value(owner.rpc('change_member_role',{p_project_id:a,p_user_id:users[1],p_new_role:'viewer'}));
 assert.equal((await member.rpc('set_task_item_percentage',{p_task_item_id:item,p_percentage:60})).error?.code,'42501');
 await member.removeAllChannels();const viewer=await channel(member,'project:'+a);
 await value(owner.rpc('update_task',{p_task_id:task,p_title:'Viewer can read only'}));await until(()=>viewer.events.length>0);
 checks.push('downgraded viewer retains read subscription and cannot mutate');
 const out=process.env.TASKTRACE_SECURITY_EVIDENCE||root+'/.expo/security-evidence';mkdirSync(out,{recursive:true});
 writeFileSync(out+'/realtime-lifecycle.json',JSON.stringify({checks,checks_passed:checks.length,cached_events_after_revoke:cachedAfterRevoke,
  cached_payload_contains_only_routing_metadata:true,fresh_joins_after_revoke_denied:true,foreign_project_events:foreignTopic.events.length},null,2));
 console.log('PASS real Realtime lifecycle: isolation, reconnect, revoke/re-auth denial, membership restore, viewer downgrade; '+checks.length+' groups; '+cachedAfterRevoke+' cached routing events after revoke');
}finally{
 for(const c of clients){await c.removeAllChannels().catch(()=>undefined);c.realtime.disconnect();}
 for(const [client,project]of projects){await client.rpc('archive_project',{p_project_id:project});await client.rpc('hard_delete_project',{p_project_id:project});}
 // Audit intentionally retains actor identities. The runner drops this entire
 // synthetic database; do not try to delete referenced users or audit rows.
 await db.end();
}
