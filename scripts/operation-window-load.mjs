// Laboratory throughput/storage evidence on a disposable database. Network,
// compute and cluster-wide WAL numbers are NOT production capacity claims.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSecurityDatabase } from './security-test-harness.mjs';
import { startSecurityApi } from './security-test-api.mjs';
const env=await createSecurityDatabase();let api;const out=resolve('.expo','operation-window-load',Date.now()+'-'+process.pid);mkdirSync(out,{recursive:true});
const report={laboratory:true,operations:512,concurrency:16,users:8,rounds:[]};
const value=async q=>{const r=await q;if(r.error)throw Object.assign(new Error(r.error.message),r.error);return r.data;};
const quantiles=samples=>{const a=[...samples].sort((a,b)=>a-b);return {p50:a[Math.floor(a.length*.5)],p95:a[Math.floor(a.length*.95)],p99:a[Math.floor(a.length*.99)]};};
try{
 api=await startSecurityApi(env);const users=Array.from({length:report.users},()=>randomUUID());
 for(const u of users)await env.db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')",[u,u+'@load.test']);
 const clients=users.map(u=>api.client(u)),context=await value(clients[0].rpc('get_client_operation_context'));
 const commands=Array.from({length:report.operations},(_,n)=>({n,id:randomUUID(),client:clients[n%clients.length]}));
 const call=(command,ctx=context)=>command.client.rpc('execute_client_mutation_v3',{p_generation:ctx.generation,p_epoch:ctx.epoch,p_operation_id:command.id,p_name:'create_project',p_args:{p_name:'Load '+command.id}});
 async function series(replay){let index=0;const times=[],started=performance.now();
  await Promise.all(Array.from({length:report.concurrency},async()=>{for(;;){const command=commands[index++];if(!command)break;const start=performance.now(),result=await value(call(command));times.push(performance.now()-start);if(replay)assert.equal(result,command.result);else command.result=result;}}));
  return {durationMs:performance.now()-started,latencyMs:quantiles(times)};
 }
 const walBefore=(await env.db.query('select pg_current_wal_lsn() lsn')).rows[0].lsn;
 report.claim=await series(false);report.replay=await series(true);
 report.storage=(await env.db.query("select count(*)::int receipts,avg(accounted_bytes)::float avg_logical_bytes,sum(accounted_bytes)::text logical_bytes,pg_relation_size('private.client_operation_receipts_v3')::text heap_bytes,pg_indexes_size('private.client_operation_receipts_v3')::text index_bytes from private.client_operation_receipts_v3")).rows[0];
 assert.equal(report.storage.receipts,report.operations);
 report.clusterWalBytesDuringSample=(await env.db.query('select pg_wal_lsn_diff(pg_current_wal_lsn(),$1)::text bytes',[walBefore])).rows[0].bytes;
 report.clusterWalLimitation='Shared local cluster may have background activity; this is not per-operation attributable WAL.';
 report.plans=(await env.db.query('explain (format json) select * from private.client_operation_receipts_v3 where generation=$1 and epoch=$2 and user_id=$3 and operation_id=$4',[context.generation,context.epoch,users[0],commands[0].id])).rows;
 const verify=async()=>{const actual=(await env.db.query('select count(*)::text n,coalesce(sum(accounted_bytes),0)::text bytes from private.client_operation_receipts_v3')).rows[0];
  const global=(await env.db.query("select receipt_count::text n,logical_bytes::text bytes from private.client_operation_live_budgets where scope='global'")).rows[0];assert.deepEqual(global,actual);};
 await verify();
 const retire=async ctx=>{
  await env.db.query(`create or replace function private.operation_clock() returns timestamptz language sql volatile set search_path='' as $$ select '${new Date(Date.parse(ctx.replay_until)+1000).toISOString()}'::timestamptz $$`);
  const start=performance.now();let deleted=0;
  for(let n=0;n<100;n++){const r=await env.db.query('select private.run_client_operation_lifecycle(500) r');deleted+=r.rows[0].r.deleted_receipts;await verify();if(!(await env.db.query('select count(*)::int n from private.client_operation_epochs')).rows[0].n)break;}
  assert.equal((await env.db.query('select count(*)::int n from private.client_operation_receipts_v3')).rows[0].n,0);
  return {deleted,durationMs:performance.now()-start};
 };
 report.cleanup=await retire(context);assert.equal(report.cleanup.deleted,report.operations);
 assert.equal((await call(commands[0])).error?.code,'TT_OPERATION_EXPIRED');
 for(let round=0;round<5;round++){
  const ctx=await value(clients[0].rpc('get_client_operation_context'));
  for(let n=0;n<32;n++)await value(call({id:randomUUID(),client:clients[n%clients.length]},ctx));
  report.rounds.push({epoch:ctx.epoch,...await retire(ctx)});
 }
 report.final=(await env.db.query("select (select count(*) from private.client_operation_receipts_v3)::int receipts,(select count(*) from private.client_operation_epochs)::int epochs,(select count(*) from private.client_operation_live_budgets where scope<>'global')::int user_budgets,pg_relation_size('private.client_operation_receipts_v3')::text heap_bytes,(select n_dead_tup from pg_stat_user_tables where schemaname='private' and relname='client_operation_receipts_v3')::text dead_tuples,(select last_autovacuum from pg_stat_user_tables where schemaname='private' and relname='client_operation_receipts_v3') last_autovacuum")).rows[0];
 assert.equal(report.final.receipts,0);assert.equal(report.final.epochs,0);assert.equal(report.final.user_budgets,0);
 console.log('PASS laboratory claim/replay, exact live accounting, bounded cleanup and five long-horizon epochs');console.log(JSON.stringify(report));
}finally{writeFileSync(resolve(out,'results.json'),JSON.stringify(report,null,2));api?.close();await env.close();}
