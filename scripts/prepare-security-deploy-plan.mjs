// Offline artifact builder only. It neither connects nor deploys anything.
// The temporary CLI lineage uses captured hosted history and only unapplied
// forward migrations. Historical Git migrations are never replayed/repaired.
import { readFileSync,readdirSync,writeFileSync,mkdirSync,copyFileSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { root } from './security-test-harness.mjs';

const [baselinePath,destination,snapshotPath]=process.argv.slice(2);
if(!baselinePath||!destination)throw Error('Usage: node scripts/prepare-security-deploy-plan.mjs <captured-hosted-history.json> <new-plan-directory> [captured-schema.json]');
const dir=resolve(destination);
if(existsSync(dir))throw Error('Use a new empty destination; an existing plan is never overwritten');
const history=JSON.parse(readFileSync(baselinePath,'utf8'));
if(!Array.isArray(history)||!history.length)throw Error('Captured migration history required');
const sha=s=>createHash('sha256').update(s).digest('hex');
// Conservative source equality: normalize EOL/terminal empty statements only.
// Never rewrite quoted identifiers, literals or function bodies to infer that
// a differently timestamped migration was applied. Drift requires review.
const normalize=s=>s.replace(/\r\n/g,'\n').trim().replace(/(?:;\s*)+$/,'');
const manifest={kind:'tasktrace-security-deployment-plan',production_applied:false,baseline_source_sha256:sha(readFileSync(baselinePath)),
 baseline_snapshot_sha256:snapshotPath?sha(readFileSync(snapshotPath)):null,baseline:[],pending:[],already_applied_forward:[],required_pending_count:0};
const migrationDir=resolve(dir,'supabase/migrations');mkdirSync(migrationDir,{recursive:true});
copyFileSync(root+'/supabase/config.toml',resolve(dir,'supabase/config.toml'));
const versions=new Set();
for(const row of history){
 if(!/^\d{14}$/.test(row.version)||versions.has(row.version)||!Array.isArray(row.statements)||row.statements.some(s=>typeof s!=='string'))throw Error('Unexpected hosted history format');
 versions.add(row.version);
 const name=row.name||'hosted_baseline';
 if(!/^[a-z0-9_]+$/.test(name))throw Error('Review the unsupported hosted migration name before constructing its path');
 const file=row.version+'_'+name+'.sql',source=row.statements.join(';\n')+';\n';
 writeFileSync(resolve(migrationDir,file),source);
 manifest.baseline.push({version:row.version,name:row.name,file,sha256:sha(source),already_applied:true});
}
const files=readdirSync(root+'/supabase/migrations').filter(f=>f.endsWith('.sql')&&f>='20261016191158_').sort();
for(const file of files){
 const version=file.slice(0,14),name=file.slice(15,-4),source=readFileSync(root+'/supabase/migrations/'+file,'utf8');
 const matches=history.filter(row=>row.version===version||row.name===name);
 if(matches.length>1)throw Error('Ambiguous hosted lineage for '+file);
 if(matches.length){
  const applied=matches[0];
  if(normalize(source)!==normalize(applied.statements.join(';\n')))throw Error('Hosted migration source drift: '+file);
  manifest.already_applied_forward.push({file,hosted_version:applied.version,sha256:sha(source),matched_by:applied.version===version?'version':'equivalent_source_and_name'});
  continue;
 }
 writeFileSync(resolve(migrationDir,file),source);
 manifest.pending.push({version,file,sha256:sha(source),already_applied:false});
}
manifest.required_pending_count=manifest.pending.length;
writeFileSync(resolve(dir,'manifest.json'),JSON.stringify(manifest,null,2));
console.log(`Prepared offline deployment lineage: ${history.length} actual hosted-history files + ${manifest.pending.length} unapplied forward migrations; no connection or deployment performed`);
