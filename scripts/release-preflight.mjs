// Offline comparison of the read-only catalog query result. This tool has no
// database credentials and cannot modify a database or migration history.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function comparePreflight(actual,expected) {
 for(const key of ['project','schemas','functions','tables','columns','policies','constraints','triggers','indexes','history']) {
  assert.ok(Object.hasOwn(actual,key),'Catalog lacks '+key);
  if(!isDeepStrictEqual(expected[key],actual[key]))throw Error('STOP: production '+key+' differs from the reviewed baseline; no migration may start');
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const args=process.argv.slice(2),position=args.indexOf('--catalog');
 assert(position>=0&&args[position+1],'Supply --catalog with the saved preflight.sql JSON result');
 const expected=JSON.parse(readFileSync('docs/release/production-preconditions-2026-10-24.json','utf8'));
 const text=readFileSync(args[position+1],'utf8');
 const actual=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
 comparePreflight(actual,expected);
 console.log('PASS exact catalog/ACL/RLS/constraint/trigger/index/history preconditions. Publication hold and backup checks are separate mandatory prerequisites.');
}
