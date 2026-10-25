import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function verifySecurityAcceptance(outputs,policyBytes,lockBytes,now=Date.now()) {
 assert.ok(outputs?.status==='PASS'||outputs?.status==='PASS WITH APPROVED EXCEPTION','Actual security policy decision required');
 assert.equal(outputs.policySha256,sha(policyBytes),'Security policy changed after verification');
 assert.equal(outputs.lockSha256,sha(lockBytes),'Dependency lock changed after verification');
 if(outputs.status==='PASS')assert.equal(outputs.npmAudit,'PASS','Clean security decision requires clean raw audit');
 else {
  assert.equal(outputs.npmAudit,'FAIL','Exception must retain raw audit FAIL');
  const policy=JSON.parse(policyBytes);
  assert.equal(policy.exceptionProfile,'expo57-unsigned-tooling-20261025');
  assert.equal(policy.activated,true);
  assert.deepEqual(policy.advisories.map(a=>a.id).sort(),['GHSA-86w9-cpqp-85rv','GHSA-mrhx-c7xc-m3w5']);
  assert.equal(Date.parse(policy.expiresAt)-Date.parse(policy.startsAt),14*24*60*60*1000);
  assert.ok(Number.isFinite(now)&&now>=Date.parse(policy.startsAt)&&now<Date.parse(policy.expiresAt),'Security exception expired or not yet active at release decision');
 }
 return {status:outputs.status,npmAudit:outputs.npmAudit,policySha256:outputs.policySha256,lockSha256:outputs.lockSha256,
  expiresAt:outputs.status==='PASS WITH APPROVED EXCEPTION'?JSON.parse(policyBytes).expiresAt:null};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const results=JSON.parse(process.env.ACCEPTANCE_RESULTS??'{}'),checks={};
 for(const name of ['static','database','security']) {
  checks[name]=results[name]?.result;
  assert.equal(checks[name],'success','Required release job '+name+' did not succeed');
 }
 const security=verifySecurityAcceptance(results.security.outputs,readFileSync('scripts/security-policy.json'),readFileSync('package-lock.json'));
 assert.match(process.env.ACCEPTANCE_COMMIT??'',/^[a-f0-9]{40}$/);
 assert.equal(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),process.env.ACCEPTANCE_COMMIT,'Receipt must identify the tested checkout');
 mkdirSync('.expo/release-acceptance',{recursive:true});
 writeFileSync('.expo/release-acceptance/acceptance.json',JSON.stringify({commit:process.env.ACCEPTANCE_COMMIT,checks,security,decision:'PASS',
  runUrl:process.env.ACCEPTANCE_RUN_URL,manifestSha256:sha(readFileSync('docs/release/manifest.json'))},null,2)+'\n');
}
