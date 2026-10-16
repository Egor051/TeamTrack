// Local managed-image compatibility + a logical backup/restore rehearsal.
// It never connects to hosted Supabase or changes the existing local server.
import assert from 'node:assert/strict';
import { spawn,spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync,writeFileSync,mkdirSync,createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { createSecurityDatabase,securityDatabaseContainers,docker,root,connect,asUser,snapshotDiff } from './security-test-harness.mjs';

if(process.env.TASKTRACE_SECURITY_POSTGRES_CONTAINER)throw Error('The upgrade runner must start from the existing local server');
const image='public.ecr.aws/supabase/postgres:17.11.0.004';
const name='tasktrace-security-postgres-'+process.pid;
const out=resolve(process.env.TASKTRACE_SECURITY_EVIDENCE||root+'/.expo/security-evidence','pg17.11');
mkdirSync(out,{recursive:true});
const {providerContainer}=securityDatabaseContainers();
const network=docker(['inspect',providerContainer,'--format','{{.HostConfig.NetworkMode}}']);
const sql=(source,db='postgres')=>{
 if(db!=='postgres'&&!/^teamtrack_audit_\d+$/.test(db))throw Error('Unsafe restore target');
 return docker(['exec','-i',name,'psql','-X','-U','supabase_admin','-d',db,'-v','ON_ERROR_STOP=1'],source);
};
async function run(script,args=[]){
 const log=createWriteStream(resolve(out,script.split('/').at(-1).replace('.mjs','')+(args.includes('--hosted')?'-hosted':'')+'.log'));
 try{await new Promise((ok,no)=>{
  const child=spawn(process.execPath,[script,...args],{cwd:root,env:{...process.env,TASKTRACE_SECURITY_POSTGRES_CONTAINER:name,TASKTRACE_SECURITY_EVIDENCE:out},windowsHide:true});
  child.stdout.on('data',chunk=>{log.write(chunk);process.stdout.write(chunk);});
  child.stderr.on('data',chunk=>{log.write(chunk);process.stderr.write(chunk);});
  child.once('error',no);child.once('exit',code=>code===0?ok():no(Error(script+' exited '+code)));
 });}finally{await new Promise(r=>log.end(r));}
}
let source,restored,restoredCreated=false;
try{
 docker(['run','-d','--name',name,'--network',network,'-p','127.0.0.1::5432','--tmpfs','/var/lib/postgresql/data',
  '-e','POSTGRES_PASSWORD=postgres',image,'postgres','-D','/etc/postgresql','-c','listen_addresses=*']);
 let ready=false;
 for(let n=0;n<180;n++){
  const r=spawnSync('docker',['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres'],{encoding:'utf8'});
  if(r.status===0){ready=true;break;}await new Promise(r=>setTimeout(r,200));
 }
 assert(ready,'Postgres 17.11 startup failed');
 const targetVersion=sql('select version();');assert.match(targetVersion,/PostgreSQL 17\.11/);
 console.log('PASS target image boots on PostgreSQL 17.11');
 source=await createSecurityDatabase();
 const user=randomUUID(),operation=randomUUID();
 await source.db.query('set search_path=public,extensions');
 await source.db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'restore@security.test','{}')",[user]);
 let item,ack;
 await asUser(source.db,user,async()=>{
  const project=(await source.db.query("select public.create_project('Restore rehearsal') id")).rows[0].id;
  const task=(await source.db.query("select public.create_task($1,'Restored stage') id",[project])).rows[0].id;
  item=(await source.db.query("select public.create_task_item($1,'Restored item') id",[task])).rows[0].id;
  ack=(await source.db.query('select public.apply_task_item_percentage_operation_v2($1,$2,1,65) value',[operation,item])).rows[0].value;
 });
 const snapshotSql=readFileSync(root+'/supabase/tests/security_snapshot.sql','utf8');
 const before=(await source.db.query(snapshotSql)).rows[0].snapshot;
 const checksumSql=`select md5(jsonb_build_array(
  (select jsonb_agg(to_jsonb(t) order by id) from public.task_items t),
  (select jsonb_agg(to_jsonb(t) order by id) from public.audit_log t),
  (select jsonb_agg(to_jsonb(t) order by user_id,operation_id) from private.client_operation_receipts t),
  (select jsonb_agg(to_jsonb(t) order by cursor) from private.task_item_sync_changes t))::text) checksum`;
 const checksum=(await source.db.query(checksumSql)).rows[0].checksum;
 const dump=docker(['exec',source.container,'pg_dump','-U','supabase_admin','-d',source.database]);
 sql('create database '+source.database+' owner postgres;');restoredCreated=true;
 sql(dump,source.database);
 const port=Number(docker(['port',name,'5432/tcp']).match(/:(\d+)\s*$/m)[1]);
 restored=connect(port,source.database);await restored.connect();await restored.query('set search_path=public,extensions');
 const after=(await restored.query(snapshotSql)).rows[0].snapshot;
 const differences=snapshotDiff(before,after),cosmetic=[];
 if(differences.constraints){
  // 17.11's deparser flattens nested AND nodes when restoring CHECK text.
  // Accept only this known expression, with identical non-parenthesis tokens
  // and no OR/NOT; every other schema difference remains a test failure.
  assert.equal(differences.constraints.length,1);
  const change=differences.constraints[0];assert.equal(change.id,'public.profiles/profiles_display_name_valid');
  assert(!/\b(or|not)\b/.test(change.left.definition));
  assert.equal(change.left.definition.replace(/[()\s]/g,''),change.right.definition.replace(/[()\s]/g,''));
  const left={...change.left},right={...change.right};delete left.definition;delete right.definition;assert.deepEqual(left,right);
  cosmetic.push('profiles CHECK deparser flattens associative AND parentheses');delete differences.constraints;
 }
 assert.deepEqual(differences,{});
 assert.equal((await restored.query(checksumSql)).rows[0].checksum,checksum);
 const repeated=await asUser(restored,user,()=>restored.query('select public.apply_task_item_percentage_operation_v2($1,$2,1,65) value',[operation,item]));
 assert.deepEqual(repeated.rows[0].value,ack);
 assert.equal((await restored.query(checksumSql)).rows[0].checksum,checksum);
 writeFileSync(resolve(out,'backup-restore.json'),JSON.stringify({source:'PostgreSQL 17.6',target:'PostgreSQL 17.11',image,
  schema_semantically_equal:true,cosmetic_differences:cosmetic,data_audit_feed_receipt_checksum_equal:true,historical_ack_equal:true,duplicate_side_effects:false},null,2));
 await restored.end();restored=null;sql('drop database '+source.database+' with(force);');restoredCreated=false;
 await source.close();source=null;
 console.log('PASS synthetic 17.6 → 17.11 logical backup/restore: schema/ACL, rows, audit, feed, receipt and unchanged duplicate ACK');
 await run('scripts/run-audit-sql-tests.mjs',['--cron','--advisors']);
 await run('scripts/test-security-hardening.mjs');
 await run('scripts/test-security-hardening.mjs',['--hosted']);
 await run('scripts/run-security-integrations.mjs');
 console.log('PASS PostgreSQL 17.11 compatibility and restore rehearsal (local image only)');
}finally{
 await restored?.end().catch(()=>undefined);
 if(restoredCreated&&source)sql('drop database '+source.database+' with(force);');
 await source?.close();
 spawnSync('docker',['rm','-f',name],{encoding:'utf8'});
}
