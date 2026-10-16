import { readFileSync,writeFileSync } from 'node:fs';
import { createSecurityDatabase,snapshotDiff,root } from './security-test-harness.mjs';
const out=process.env.TASKTRACE_SECURITY_EVIDENCE;
if(!out)throw Error('TASKTRACE_SECURITY_EVIDENCE is required');
const env=await createSecurityDatabase({baselineOnly:true});
try{
 await env.db.query('set search_path=public,extensions');
 const local=(await env.db.query(readFileSync(root+'/supabase/tests/security_snapshot.sql','utf8'))).rows[0].snapshot;
 const hosted=JSON.parse(readFileSync(out+'/hosted-schema-before.json','utf8'));
 const diff=snapshotDiff(local,hosted);
 writeFileSync(out+'/git-schema-before.json',JSON.stringify(local,null,2));
 writeFileSync(out+'/schema-diff-before.json',JSON.stringify(diff,null,2));
 console.log(JSON.stringify(Object.fromEntries(Object.entries(diff).map(([k,v])=>[k,v.map(x=>x.id)])),null,2));
}finally{await env.close();}
