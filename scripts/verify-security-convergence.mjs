import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { createSecurityDatabase,snapshotDiff,root } from './security-test-harness.mjs';
import { restoreHostedSecurityFixture } from './security-hosted-fixture.mjs';
import assert from 'node:assert/strict';
const out=process.env.TASKTRACE_SECURITY_EVIDENCE||root+'/.expo/security-evidence';
mkdirSync(out,{recursive:true});
let env=await createSecurityDatabase();
let fresh,hosted;
try{await env.db.query('set search_path=public,extensions');fresh=(await env.db.query(readFileSync(root+'/supabase/tests/security_snapshot.sql','utf8'))).rows[0].snapshot;}
finally{await env.close();}
env=await createSecurityDatabase({baselineOnly:true});
try{
 await restoreHostedSecurityFixture(env);
 await env.db.query('set search_path=public,extensions');
 const reconstructed=(await env.db.query(readFileSync(root+'/supabase/tests/security_snapshot.sql','utf8'))).rows[0].snapshot;
 writeFileSync(out+'/hosted-fixture-diff.json',JSON.stringify(snapshotDiff(reconstructed,JSON.parse(readFileSync(root+'/supabase/tests/fixtures/hosted_security_baseline_20261016.json','utf8')).snapshot),null,2));
 const files=(await import('node:fs')).readdirSync(root+'/supabase/migrations').filter(n=>n.endsWith('.sql')&&n>='20261016191158_').sort();
 for(const file of files)env.sql('set role postgres; set search_path=public,extensions;\n'+readFileSync(root+'/supabase/migrations/'+file,'utf8'));
 hosted=(await env.db.query(readFileSync(root+'/supabase/tests/security_snapshot.sql','utf8'))).rows[0].snapshot;
 for(const file of files)env.sql('set role postgres; set search_path=public,extensions;\n'+readFileSync(root+'/supabase/migrations/'+file,'utf8'));
 const repeated=(await env.db.query(readFileSync(root+'/supabase/tests/security_snapshot.sql','utf8'))).rows[0].snapshot;
 assert.deepEqual(snapshotDiff(hosted,repeated),{});
 console.log('PASS all seven forward migrations can be re-applied without schema drift');
 const diff=snapshotDiff(fresh,hosted);
 writeFileSync(out+'/git-schema-after.json',JSON.stringify(fresh,null,2));writeFileSync(out+'/hosted-lineage-after.json',JSON.stringify(hosted,null,2));writeFileSync(out+'/schema-diff-after.json',JSON.stringify(diff,null,2));
 console.log(JSON.stringify(Object.fromEntries(Object.entries(diff).map(([k,v])=>[k,v.map(x=>x.id)])),null,2));
}finally{await env.close();}
