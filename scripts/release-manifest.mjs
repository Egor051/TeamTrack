import { createHash } from 'node:crypto';
import { readFileSync, readdirSync,writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(import.meta.dirname,'..');
const names=[
 '20261022201114_audit_task_snapshot_revision.sql',
 '20261022201149_audit_rpc_outcomes.sql',
 '20261022202128_audit_receipt_budgets.sql',
 '20261023115036_operation_window_protocol.sql',
 '20261023115657_operation_window_lifecycle.sql',
 '20261024142519_release_blocker_guards.sql',
];
const sha=s=>createHash('sha256').update(s).digest('hex');
export function maintenanceSql() {
 const source=readFileSync(resolve(root,'supabase/migrations',names.at(-1)),'utf8');
 const block=source.split('-- BEGIN RELEASE FENCE')[1]?.split('-- END RELEASE FENCE')[0];
 if(!block)throw Error('Release fence block missing');
 return `begin;\nset local lock_timeout='5s';\n-- Drain existing writers before installing any statement triggers.\ndo $drain$ declare t record; begin\nfor t in select c.oid::regclass relation from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by c.relname loop\nexecute format('lock table %s in share row exclusive mode',t.relation);\nend loop; end $drain$;\n`+
  '-- Fence definition shared with the forward migration.\n'+block.slice(block.indexOf('\n'))+
  "\nupdate private.release_write_control set maintenance=true where singleton;\ncommit;\n";
}
export function manifest() {
 const baseline=readFileSync(resolve(root,'docs/release/production-preconditions-2026-10-24.json'),'utf8');
 const remote=JSON.parse(baseline).history;
 const historical=readdirSync(resolve(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')&&!names.includes(f)).sort()
  .map(file=>({version:file.slice(0,14),name:file.slice(15,-4),sha256:sha(readFileSync(resolve(root,'supabase/migrations',file)))}));
 return {version:1,productionReady:false,project:'diapmbqdjunlgvivwrtp',baselineSha256:sha(baseline),
  preflightSha256:sha(readFileSync(resolve(root,'docs/release/preflight.sql'))),
  postconditionsSha256:sha(readFileSync(resolve(root,'docs/release/postconditions.sql'))),
  fixtureDifferencesSha256:sha(readFileSync(resolve(root,'docs/release/fixture-differences.json'))),
  functionTokenContractSha256:sha(readFileSync(resolve(root,'docs/release/function-token-contract.json'))),
  historicalMigrationDigests:historical,
  historicalDrift:{localOnly:historical.filter(l=>!remote.some(r=>r.version===l.version)),
   remoteOnly:remote.filter(r=>!historical.some(l=>l.version===r.version)),
   differentNames:historical.filter(l=>remote.some(r=>r.version===l.version&&r.name!==l.name)).map(l=>({version:l.version,local:l.name,remote:remote.find(r=>r.version===l.version).name}))},
  preflight:'Compare all function definitions/ACL/config, columns, policies and exact version/name history to production-preconditions-2026-10-24.json BEFORE maintenance; stop on any difference.',
  maintenanceSha256:sha(maintenanceSql()),generalDbPushAllowed:false,
  steps:names.map((file,i)=>({order:i+1,file,version:file.slice(0,14),name:file.slice(15,-4),sha256:sha(readFileSync(resolve(root,'supabase/migrations',file))),
   dependsOn:i?names[i-1]:null,writeFence:'maintenance=true; verify user RPC and direct DML return 503',
   check:['snapshot revision/backfill/ACL','historical HTTP 400/429 replay','legacy accounting; keep maintenance until configured','v3 namespace/private ACL/types','lifecycle immutable guards and cron','multi-user GC, account/namespace guards, both-policy initialization'][i],
   failure:'Stop; keep maintenance and hosting hold. Prior migration commits remain. Repair forward on a reviewed copy; never clear receipts.'}))};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const dir=resolve(root,'docs/release');mkdirSync(dir,{recursive:true});
 if(process.argv.includes('--check')) {
  const actual=JSON.parse(readFileSync(resolve(dir,'manifest.json'),'utf8'));
  if(JSON.stringify(actual)!==JSON.stringify(manifest())||readFileSync(resolve(dir,'prepare-maintenance.sql'),'utf8')!==maintenanceSql())throw Error('Release manifest/hash drift');
  console.log('PASS release manifest: exact six files, maintenance and production baseline hashes');
 } else {
  writeFileSync(resolve(dir,'manifest.json'),JSON.stringify(manifest(),null,2)+'\n');
  writeFileSync(resolve(dir,'prepare-maintenance.sql'),maintenanceSql());
  console.log('Release artifacts generated; no database connection or deployment');
 }
}
