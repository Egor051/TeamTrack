// Hard PostgreSQL crashes and a traffic-fenced logical restore on an OWNED
// disposable container. Never restart/restore the existing local/hosted server.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSecurityDatabase,securityDatabaseContainers,docker,connect } from './security-test-harness.mjs';
import { startSecurityApi } from './security-test-api.mjs';
const name='tasktrace-security-postgres-'+process.pid;
const {providerContainer}=securityDatabaseContainers();
if(process.env.TASKTRACE_SECURITY_POSTGRES_CONTAINER)throw Error('Must start from original provider inventory');
const image=docker(['inspect',providerContainer,'--format','{{.Config.Image}}']);
const network=docker(['inspect',providerContainer,'--format','{{.HostConfig.NetworkMode}}']);
const evidence=resolve('.expo','operation-window-crash',Date.now()+'-'+process.pid);mkdirSync(evidence,{recursive:true});
const results=[],disconnects=[],expectedDisconnects=new WeakSet();let env,api,db,gate;
const watch=(client,label)=>client.on('error',error=>{
 if(!expectedDisconnects.has(client))throw error;
 disconnects.push({label,code:error.code??null,message:error.message});
});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const value=async q=>{const r=await q;if(r.error)throw Object.assign(new Error(r.error.message),r.error);return r.data;};
const ready=async()=>{for(let i=0;i<180;i++){if(spawnSync('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres'],{windowsHide:true}).status===0)return;await pause(200);}throw Error('Owned Postgres startup timeout');};
const reconnect=async()=>{env.port=Number(docker(['port',name,'5432/tcp']).match(/:(\d+)\s*$/m)[1]);db=connect(env.port,env.database,'crash_verifier');watch(db,'verifier');await db.connect();};
const restart=async()=>{
 assert.match(name,/^tasktrace-security-postgres-\d+$/);assert.notEqual(name,providerContainer);
 for(const client of [db,env.db,gate])if(client)expectedDisconnects.add(client);
 docker(['kill','--signal','KILL',name]);docker(['start',name]);await ready();await reconnect();
 // A healthy postmaster is not proof that PostgREST's pool/schema cache has
 // reconnected. Poll a READ-ONLY endpoint, never retry the tested mutation.
 if(api){let loaded=false;for(let n=0;n<100;n++){const response=await fetch(api.url,{signal:AbortSignal.timeout(2000)}).catch(()=>null);if(response?.ok){loaded=true;break;}await pause(100);}assert(loaded,'PostgREST did not recover its schema cache');}
};
const check=async(name,test)=>{await test();results.push({name,result:'PASS'});console.log('PASS '+name);};
try{
 docker(['run','-d','--name',name,'--network',network,'-p','127.0.0.1::5432','-v','/var/lib/postgresql/data',
  '-e','POSTGRES_PASSWORD=postgres',image,'postgres','-D','/etc/postgresql','-c','listen_addresses=*']);
 await ready();process.env.TASKTRACE_SECURITY_POSTGRES_CONTAINER=name;
 env=await createSecurityDatabase();watch(env.db,'fixture');await reconnect();api=await startSecurityApi(env);
 const u=randomUUID();await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')",[u,u+'@crash.test']);
 let client=api.client(u);const context=await value(client.rpc('get_client_operation_context'));
 const request=(id,label)=>client.rpc('execute_client_mutation_v3',{p_generation:context.generation,p_epoch:context.epoch,p_operation_id:id,p_name:'create_project',p_args:{p_name:label}}).abortSignal(AbortSignal.timeout(15000));
 const count=async label=>Number((await db.query('select count(*)::int n from public.projects where name=$1',[label])).rows[0].n);
 const beforeId=randomUUID(),afterId=randomUUID();
 await check('hard crash BEFORE commit rolls back effect and receipt; same handle safely resumes',async()=>{
  await db.query(`create function private.crash_test_gate() returns trigger language plpgsql as $$begin perform pg_advisory_xact_lock(60182999::bigint);return new;end$$;
   create trigger crash_test_gate after insert on public.projects for each row execute function private.crash_test_gate()`);
  gate=connect(env.port,env.database,'crash_gate');watch(gate,'gate');await gate.connect();await gate.query('select pg_advisory_lock(60182999::bigint)');
  const pending=request(beforeId,'Before crash').then(r=>r,e=>({error:e}));
  let waiting=false;for(let i=0;i<100;i++){waiting=(await db.query("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event='advisory' and state='active') waiting")).rows[0].waiting;if(waiting)break;await pause(20);}
  assert(waiting,'Request never reached the transaction gate');assert.equal(await count('Before crash'),0);
  await restart();await pending;
  assert.equal(await count('Before crash'),0);assert.equal((await db.query('select count(*)::int n from private.client_operation_receipts_v3 where operation_id=$1',[beforeId])).rows[0].n,0);
  const result=await value(request(beforeId,'Before crash'));assert.equal(typeof result,'string');assert.equal(await count('Before crash'),1);
 });
 await check('hard crash AFTER commit preserves exact receipt and one effect',async()=>{
  const first=await value(request(afterId,'After crash'));await restart();
  const second=await value(request(afterId,'After crash'));assert.equal(second,first);assert.equal(await count('After crash'),1);
  assert.equal((await db.query('select count(*)::int n from private.client_operation_receipts_v3 where operation_id=$1 and outcome is not null',[afterId])).rows[0].n,1);
 });
 await check('real backup rollback uses an external traffic fence and generation rotation BEFORE reopening API',async()=>{
  const dump=docker(['exec',name,'pg_dump','-U','supabase_admin','-d',env.database]);
  const lostId=randomUUID();await value(request(lostId,'Lost future'));assert.equal(await count('Lost future'),1);
  api.close();api=null; // External traffic fence: no PostgREST listener exists.
  await db.end();db=null;
  env.sql('drop database '+env.database+' with(force);','postgres');env.sql('create database '+env.database+' owner postgres;','postgres');env.sql(dump);
  await reconnect();assert.equal(await count('Lost future'),0);
  const oldGeneration=(await db.query('select generation from private.client_operation_history')).rows[0].generation;
  const rotated=(await db.query('select private.rotate_client_operation_history() g')).rows[0].g;assert.notEqual(rotated,oldGeneration);
  api=await startSecurityApi(env);client=api.client(u);
  assert.equal((await request(lostId,'Lost future')).error?.code,'TT_OPERATION_HISTORY_RESET');assert.equal(await count('Lost future'),0);
  const fresh=await value(client.rpc('get_client_operation_context'));
  await value(client.rpc('execute_client_mutation_v3',{p_generation:fresh.generation,p_epoch:fresh.epoch,p_operation_id:randomUUID(),p_name:'create_project',p_args:{p_name:'After fenced restore'}}));
  assert.equal(await count('After fenced restore'),1);
 });
}finally{
 writeFileSync(resolve(evidence,'results.json'),JSON.stringify(results,null,2));writeFileSync(resolve(evidence,'expected-disconnects.json'),JSON.stringify(disconnects,null,2));api?.close();await gate?.end().catch(()=>{});await db?.end().catch(()=>{});
 await env?.close();delete process.env.TASKTRACE_SECURITY_POSTGRES_CONTAINER;
 // Exact container identity is locally constructed, never derived from user paths.
 spawnSync('docker',['rm','-fv',name],{encoding:'utf8',windowsHide:true});
}
