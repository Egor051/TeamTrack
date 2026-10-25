// Hosting build hold. A reviewed acceptance artifact for this exact commit is
// required. This script does not deploy or promote; neither does its workflow.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync,spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function verifyReleaseAcceptance(receipt,sha,manifestHash) {
 assert.match(sha??'',/^[a-f0-9]{40}$/,'Explicit approved commit required');
 assert.equal(receipt?.commit,sha,'Acceptance belongs to another commit');
 assert.equal(receipt?.manifestSha256,manifestHash,'Migration manifest changed');
 assert.equal(receipt?.decision,'PASS','Release acceptance failed');
 for(const check of ['static','database','security'])assert.equal(receipt?.checks?.[check],'success','Required '+check+' acceptance missing');
 assert.match(receipt?.runUrl??'',/^https:\/\/github\.com\/Egor051\/TeamTrack\/actions\/runs\/\d+$/,'Acceptance workflow URL required');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 assert.equal(process.env.TASKTRACE_RELEASE_APPROVED_SHA,sha,'Release hold: operator-approved exact SHA required');
 assert.equal(execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),'','Tracked files differ from approved commit');
 assert.ok(process.env.TASKTRACE_RELEASE_ACCEPTANCE_FILE,'Release hold: download the successful acceptance artifact first');
 const receipt=JSON.parse(readFileSync(process.env.TASKTRACE_RELEASE_ACCEPTANCE_FILE,'utf8'));
 const manifestHash=createHash('sha256').update(readFileSync('docs/release/manifest.json')).digest('hex');
 verifyReleaseAcceptance(receipt,sha,manifestHash);
 const result=spawnSync(process.platform==='win32'?'npm.cmd':'npm',['run','build:web'],{stdio:'inherit',shell:process.platform==='win32',env:process.env});
 process.exitCode=result.status??1;
}
