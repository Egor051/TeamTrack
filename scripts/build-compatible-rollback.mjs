// Build a separate v3-compatible JS/export artifact. It deliberately retains
// the storage/handle/namespace fixes; the old HEAD binary is not a rollback.
import { createHash } from 'node:crypto';
import { execFileSync,spawnSync } from 'node:child_process';
import { readdirSync,readFileSync,writeFileSync } from 'node:fs';
import { resolve,relative } from 'node:path';
const root=resolve(import.meta.dirname,'..'),out=resolve(root,'.expo/compatible-rollback');
const env={...process.env,EXPO_NO_DOTENV:'1',EXPO_PUBLIC_SUPABASE_URL:process.env.EXPO_PUBLIC_SUPABASE_URL??'https://ci.invalid.supabase.co',
 EXPO_PUBLIC_SUPABASE_ANON_KEY:process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY??'ci-public-anon-key'};
const result=spawnSync(process.execPath,['scripts/security-export.mjs','--platform','web','--platform','android','--platform','ios','--source-maps','--output-dir',out],{cwd:root,env,stdio:'inherit',windowsHide:true});
if(result.status!==0)process.exit(result.status??1);
const worker=spawnSync(process.execPath,['scripts/generate-service-worker.mjs',out],{cwd:root,env,stdio:'inherit',windowsHide:true});
if(worker.status!==0)process.exit(worker.status??1);
const sha=data=>createHash('sha256').update(data).digest('hex');
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(resolve(dir,e.name)):[resolve(dir,e.name)]);}
const source=createHash('sha256');
for(const file of [...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))].sort()) {
 source.update(file+'\0');source.update(readFileSync(resolve(root,file)));
}
writeFileSync(resolve(out,'rollback-manifest.json'),JSON.stringify({kind:'v3-compatible-rollback',protocol:3,webStorageVersion:5,nativeStorageVersion:6,
 operationKeyPrefix:'sync:mutation:v3:',newAttemptUuidVersion:8,head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
 sourceSha256:source.digest('hex'),localVerificationOnly:env.EXPO_PUBLIC_SUPABASE_URL.includes('ci.invalid'),
 limitation:'JS exports, not an installed native binary or a physical-device acceptance. Use approved public configuration before production.',
 files:files(out).filter(f=>!f.endsWith('rollback-manifest.json')).map(file=>({file:relative(out,file).replaceAll('\\','/'),sha256:sha(readFileSync(file))}))},null,2)+'\n');
console.log('PASS built separate compatible rollback artifact; no publication');
