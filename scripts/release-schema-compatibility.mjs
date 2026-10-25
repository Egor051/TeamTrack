// Compare the historical isolated fixture to the observed production catalog.
// History itself is deliberately not synthesized/repaired in either database.
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { createSecurityDatabase } from './security-test-harness.mjs';
import { sqlFunctionFingerprint } from './release-sql-fingerprint.mjs';
const env=await createSecurityDatabase({beforeVersion:'20261022201114'});
try {
 const sql=readFileSync('docs/release/preflight.sql','utf8').replace(/^'history',.*$/m,"'history','[]'::jsonb,");
 const response=await env.db.query(sql),actual=(Array.isArray(response)?response:[response]).find(r=>r.rows?.[0]?.preflight).rows[0].preflight;
 const expected=JSON.parse(readFileSync('docs/release/production-preconditions-2026-10-24.json','utf8')),diff={};
 // Canonical tokens make a Linux checkout comparable to Windows CRLF sources.
 // Raw production hashes are never normalized by release-preflight.mjs.
 const contract=JSON.parse(readFileSync('docs/release/function-token-contract.json','utf8'));
 await env.db.query("set search_path=''");
 for(const row of actual.functions) {
  const signature=row.signature.replace(/^(public|private)\.\1\./,'$1.');
  const definition=(await env.db.query('select pg_get_functiondef($1::regprocedure) definition',[signature])).rows[0].definition;
  row.sha256=sqlFunctionFingerprint(definition);
 }
 for(const row of expected.functions) {
  const known=contract.functions.find(f=>f.signature===row.signature);assert(known,'Missing observed production token contract');
  row.sha256=known.sha256;
 }
 for(const key of ['schemas','functions','tables','columns','policies','constraints','triggers','indexes']) {
  if(!isDeepStrictEqual(actual[key],expected[key])) {
   const identify=r=>r.signature??[r.schema??r.schemaname,r.table??r.tablename,r.column??r.policyname??r.name??r.indexname].filter(Boolean).join('/');
   const a=new Map(actual[key].map(r=>[identify(r),r])),b=new Map(expected[key].map(r=>[identify(r),r]));
   diff[key]=[...new Set([...a.keys(),...b.keys()])].filter(id=>!isDeepStrictEqual(a.get(id),b.get(id))).map(id=>({id,local:a.get(id),production:b.get(id)}));
  }
 }
 mkdirSync('.expo/release-acceptance',{recursive:true});writeFileSync('.expo/release-acceptance/schema-compatibility.json',JSON.stringify({diff},null,2)+'\n');
 const definitions=[];
 await env.db.query("set search_path=''");
 for(const entry of diff.functions??[]) {
  const signature=entry.id.replace(/^(public|private)\.\1\./,'$1.');
  const row=(await env.db.query('select pg_get_functiondef($1::regprocedure) definition',[signature])).rows[0];
  definitions.push({signature,...row});
 }
 writeFileSync('.expo/release-acceptance/local-function-definitions.json',JSON.stringify(definitions,null,2)+'\n');
 const reviewed=JSON.parse(readFileSync('docs/release/fixture-differences.json','utf8')).deltas;
 const unknown=Object.entries(diff).flatMap(([collection,entries])=>entries.filter(entry=>!reviewed.some(r=>r.collection===collection&&r.id===entry.id&&isDeepStrictEqual(r.local,entry.local)&&isDeepStrictEqual(r.production,entry.production))).map(entry=>({collection,...entry})));
 writeFileSync('.expo/release-acceptance/schema-compatibility.json',JSON.stringify({diff,unreviewed:unknown,reviewedPairs:reviewed.length},null,2)+'\n');
 assert.equal(unknown.length,0,'Unreviewed historical fixture drift; release stops');
 for(const name of ['set_updated_at','prevent_history_mutation']) {
  await assert.rejects(env.db.query('select public.'+name+'()'),error=>error.code==='0A000');
 }
 console.log('PASS trigger-only helper functions cannot execute as ordinary SQL/RPC, even for their owner');
 console.log('PASS F08 all observed function tokens and schema contracts; only exact reviewed fixture metadata pairs differ. Production preflight remains RAW/exact.');
}finally{await env.close();}
