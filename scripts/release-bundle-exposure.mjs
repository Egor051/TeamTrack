import assert from 'node:assert/strict';
import { readdirSync,readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve,relative } from 'node:path';
import { createHash } from 'node:crypto';
const root=resolve(process.argv[2]??'.expo/compatible-rollback');
const maps=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?maps(resolve(dir,e.name)):e.name.endsWith('.map')?[resolve(dir,e.name)]:[]);
const results=maps(root).map(file=>{
 const bytes=readFileSync(file),source=JSON.parse(bytes.toString('utf8'));
 const matches=(source.sources??[]).filter(s=>/(?:^|\/)(?:node-forge|zod|braces)(?:\/|$)/.test(s.replaceAll('\\','/')));
 return {file:relative(root,file).replaceAll('\\','/'),sha256:createHash('sha256').update(bytes).digest('hex'),sources:source.sources?.length??0,matches};
});
for(const platform of ['android','ios','web'])assert(results.some(r=>r.file.includes('/'+platform+'/')),'Missing '+platform+' source map');
mkdirSync('.expo/release-acceptance',{recursive:true});
writeFileSync('.expo/release-acceptance/bundle-exposure.json',JSON.stringify(results,null,2)+'\n');
assert(results.every(r=>r.matches.length===0),'Vulnerable package present in an app export');
console.log('PASS current web/android/ios source maps: node-forge/zod/braces absent. Raw audit and tooling exposure remain separate.');
