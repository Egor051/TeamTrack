// Cleanup benchmark on synthetic receipts; not a production mixed-workload SLA.
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSecurityDatabase,connect } from './security-test-harness.mjs';
const env=await createSecurityDatabase(),results=[];const out=resolve('.expo/release-acceptance');mkdirSync(out,{recursive:true});
const check=async()=>{
 const actual=(await env.db.query('select count(*)::text n,coalesce(sum(accounted_bytes),0)::text bytes from private.client_operation_receipts_v3')).rows[0];
 const budget=(await env.db.query("select receipt_count::text n,logical_bytes::text bytes from private.client_operation_live_budgets where scope='global'")).rows[0];
 assert.deepEqual(budget,actual);
 assert.equal((await env.db.query("select count(*)::int n from private.client_operation_live_budgets b left join (select 'user:'||user_id::text scope,count(*) n,sum(accounted_bytes) bytes from private.client_operation_receipts_v3 group by user_id) r using(scope) where b.scope<>'global' and (b.receipt_count,b.logical_bytes) is distinct from (coalesce(r.n,0),coalesce(r.bytes,0))")).rows[0].n,0);
};
async function seed(users,operations,epochs=1) {
 const generation=(await env.db.query('select generation from private.client_operation_history')).rows[0].generation;
 for(let round=0;round<epochs;round++) {
  const epoch=(await env.db.query('update private.client_operation_history set current_epoch=current_epoch+1 returning current_epoch')).rows[0].current_epoch;
  await env.db.query("insert into private.client_operation_epochs(generation,epoch,admit_until,replay_until,state) values($1,$2,clock_timestamp()-interval '32 days',clock_timestamp()-interval '1 day','retired')",[generation,epoch]);
  await env.db.query(`insert into private.client_operation_receipts_v3(generation,epoch,user_id,operation_id,operation_type,target_id,request_fingerprint,outcome,completed_at,result_limit,accounted_bytes)
   select $1,$2,md5(u::text)::uuid,gen_random_uuid(),'rpc:create_project',gen_random_uuid(),decode(repeat('00',32),'hex'),'{"value":true,"http_status":200}'::jsonb,clock_timestamp()-interval '31 days',1024,327
   from generate_series(1,$3) u cross join generate_series(1,$4) op`,[generation,epoch,users,operations]);
 }
 await env.db.query(`insert into private.client_operation_live_budgets(scope,receipt_count,logical_bytes)
  select 'user:'||user_id::text,count(*),sum(accounted_bytes) from private.client_operation_receipts_v3 group by user_id
  union all select 'global',count(*),coalesce(sum(accounted_bytes),0) from private.client_operation_receipts_v3
  on conflict(scope) do update set receipt_count=excluded.receipt_count,logical_bytes=excluded.logical_bytes`);
}
try {
 await env.db.query("insert into auth.users(id,email,raw_user_meta_data) select md5(n::text)::uuid,'gc-'||n||'@release.invalid','{}'::jsonb from generate_series(1,10000) n");
 for(const [users,operations] of [[100,1],[1000,1],[10000,1],[10000,20]]) {
  await seed(users,operations);await check();const start=performance.now(),ticks=[];
  for(let tick=0;tick<1000;tick++) {
   const began=performance.now(),r=(await env.db.query('select private.run_client_operation_lifecycle(500) value')).rows[0].value;
   ticks.push({deleted:r.deleted_receipts,ms:performance.now()-began});
   if(!(await env.db.query('select count(*)::int n from private.client_operation_epochs')).rows[0].n)break;
  }
  await check();assert.equal((await env.db.query('select count(*)::int n from private.client_operation_receipts_v3')).rows[0].n,0);
  assert.equal(ticks[0].deleted,Math.min(500,users*operations));
  results.push({users,operationsPerUser:operations,receipts:users*operations,ticks:ticks.length,firstTick: ticks[0],durationMs:performance.now()-start,maxTickMs:Math.max(...ticks.map(t=>t.ms)),
   limitation:'Ticks accelerated; cron cadence is calculated, not waited. Receipt cleanup only, not concurrent real business workload.'});
  console.log('PASS GC '+users+' users x '+operations+' receipts: '+ticks.length+' bounded ticks, exact global/user accounting');
 }
 await seed(100,1,12);
 const first=(await env.db.query('select private.run_client_operation_lifecycle(10) value')).rows[0].value;assert.equal(first.deleted_receipts,80);
 await env.db.query('select private.run_client_operation_lifecycle(10)');
 assert.equal((await env.db.query('select count(*)::int n from private.client_operation_epochs where gc_touched_at is null')).rows[0].n,0);
 await check();console.log('PASS GC fairness: all 12 eligible epochs served within two ticks');
 const other=connect(env.port,env.database,'gc_parallel');await other.connect();
 try {await Promise.all([env.db.query('select private.run_client_operation_lifecycle(500)'),other.query('select private.run_client_operation_lifecycle(500)')]);}finally{await other.end();}
 await check();console.log('PASS GC concurrent workers: no deadlock or accounting drift');
 while((await env.db.query('select count(*)::int n from private.client_operation_epochs')).rows[0].n)await env.db.query('select private.run_client_operation_lifecycle(500)');
 const backlog=[];
 for(let day=0;day<4;day++) {
  await seed(10000,20);
  for(let tick=0;tick<288;tick++)await env.db.query('select private.run_client_operation_lifecycle(500)');
  await check();backlog.push((await env.db.query('select count(*)::int n from private.client_operation_receipts_v3')).rows[0].n);
 }
 assert(backlog[3]<=backlog[2]&&backlog[2]<=backlog[1],'Daily cleanup backlog must not grow at this measured profile');
 results.push({profile:'4 accelerated days, 10000 users x 20 new expired receipts/day, 288 ticks/day',backlog,
  limitation:'Real SQL cleanup; accelerated arrival/tick schedule. No claim of production or concurrent business throughput.'});
 console.log('PASS GC sustained accelerated profile: backlog '+JSON.stringify(backlog));
 console.log(JSON.stringify(results));
}finally{writeFileSync(resolve(out,'gc-scale-results.json'),JSON.stringify(results,null,2));await env.close();}
