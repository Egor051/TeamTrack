// Prove the temporary release lineage with the real CLI in a disposable DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createSecurityDatabase,root,snapshotDiff,asUser } from './security-test-harness.mjs';
import { restoreHostedSecurityFixture } from './security-hosted-fixture.mjs';
import { startSecurityApi } from './security-test-api.mjs';

const [baselinePath,planPath]=process.argv.slice(2);
if(!baselinePath||!planPath)throw Error('Expected captured history and the generated offline plan directory');
const history=JSON.parse(readFileSync(baselinePath,'utf8')),plan=JSON.parse(readFileSync(resolve(planPath,'manifest.json'),'utf8'));
assert.equal(plan.production_applied,false);assert.equal(history.length,65);assert.equal(plan.pending.length,7);
const env=await createSecurityDatabase({baselineOnly:true});
let api;
try{
 await restoreHostedSecurityFixture(env);
 const user=randomUUID();
 await env.db.query("insert into auth.users(id,email,raw_user_meta_data)values($1,'live-upgrade@security.test','{}')",[user]);
 const project=await asUser(env.db,user,()=>env.db.query("select public.create_project('Live API upgrade') id"));
 api=await startSecurityApi(env);
 const lookup={p_project_id:project.rows[0].id,p_identifier:'absent@security.test',p_role:'member'};
 assert((await api.client(user).rpc('add_project_member_by_identifier',lookup)).error,'Old missing lookup should fail');
 await env.db.query('create schema supabase_migrations authorization postgres;create table supabase_migrations.schema_migrations(version text primary key,statements text[],name text);alter table supabase_migrations.schema_migrations owner to postgres');
 for(const row of history)await env.db.query('insert into supabase_migrations.schema_migrations values($1,$2,$3)',[row.version,row.statements,row.name]);
 const uri='postgresql://postgres:postgres@127.0.0.1:'+env.port+'/'+env.database;
 const check=new pg.Client({connectionString:uri});await check.connect();assert.equal((await check.query('select current_user')).rows[0].current_user,'postgres');await check.end();
 const cli=(dry)=>new Promise((ok,no)=>{
  const args=['--yes','supabase@2.116.0','--workdir',resolve(planPath),'db','push','--db-url',uri,...(dry?['--dry-run']:['--yes'])];
  const child=spawn(process.platform==='win32'?process.env.ComSpec:'npx',process.platform==='win32'?['/d','/s','/c','npx',...args]:args,{cwd:root,windowsHide:true});
  let output='';child.stdout.on('data',s=>output+=s);child.stderr.on('data',s=>output+=s);
  child.once('error',no);child.once('exit',code=>code===0?ok(output):no(Error('Isolated CLI failed: '+output)));
 });
 const dry=await cli(true);
 for(const file of plan.pending)assert(dry.includes(file.file),'CLI did not propose '+file.file);
 const proposed=dry.split(/\r?\n/).filter(line=>/^\s*[•*]\s+\d{14}_/.test(line));
 assert.equal(proposed.length,7,'Dry-run must propose ONLY the seven new files');
 await cli(false);
 let reloaded=false;
 for(let i=0;i<15;i++){
  const result=await api.client(user).rpc('add_project_member_by_identifier',lookup);
  if(result.error?.code==='TT_MEMBER_LOOKUP'){reloaded=true;break;}
  await new Promise(r=>setTimeout(r,200));
 }
 assert(reloaded,'Running PostgREST did not adopt the changed return type/error JSON');
 assert((await env.db.query('select attempts from private.member_identifier_limits where user_id=$1',[user])).rows[0].attempts>=1);
 assert.equal((await env.db.query('select count(*)::int n from supabase_migrations.schema_migrations')).rows[0].n,72);
 assert.match(await cli(true),/up to date/i);
 await env.db.query('set search_path=public,extensions');
 const snapshot=(await env.db.query(readFileSync(root+'/supabase/tests/security_snapshot.sql','utf8'))).rows[0].snapshot;
 const expected=JSON.parse(readFileSync((process.env.TASKTRACE_SECURITY_EVIDENCE||root+'/.expo/security-evidence')+'/hosted-lineage-after.json','utf8'));
 assert.deepEqual(snapshotDiff(snapshot,expected),{});
 console.log('PASS real Supabase CLI: exactly seven pending; isolated apply records 65+7; next dry-run empty; canonical schema; running API reloads JSON error contract without restart');
}finally{api?.close();await env.close();}
