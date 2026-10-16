// Offline artifact builder only. It neither connects nor deploys anything.
// The temporary CLI lineage uses actual hosted history, followed by ONLY the
// seven new migrations. Historical Git migrations are never replayed/repaired.
import { readFileSync,readdirSync,writeFileSync,mkdirSync,copyFileSync,existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { root } from './security-test-harness.mjs';

const [baselinePath,destination]=process.argv.slice(2);
if(!baselinePath||!destination)throw Error('Usage: node scripts/prepare-security-deploy-plan.mjs <captured-hosted-history.json> <new-plan-directory>');
const dir=resolve(destination);
if(existsSync(dir))throw Error('Use a new empty destination; an existing plan is never overwritten');
const history=JSON.parse(readFileSync(baselinePath,'utf8'));
if(!Array.isArray(history)||history.length!==65)throw Error('This reviewed plan expects the audited 65-migration hosted baseline; refresh/review drift first');
const sha=s=>createHash('sha256').update(s).digest('hex');
const manifest={kind:'tasktrace-security-deployment-plan',production_applied:false,baseline_source_sha256:sha(readFileSync(baselinePath)),
 baseline:[],pending:[],required_pending_count:7};
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
if(files.length!==7)throw Error('Exactly seven reviewed forward migrations are required');
for(const file of files){
 const version=file.slice(0,14);if(versions.has(version))throw Error('New migration collides with hosted history');
 const source=readFileSync(root+'/supabase/migrations/'+file,'utf8');writeFileSync(resolve(migrationDir,file),source);
 manifest.pending.push({version,file,sha256:sha(source),already_applied:false});
}
writeFileSync(resolve(dir,'manifest.json'),JSON.stringify(manifest,null,2));
console.log('Prepared offline deployment lineage: 65 actual hosted-history files + 7 reviewed forward migrations; no connection or deployment performed');
