import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
const workflow=parse(readFileSync('.github/workflows/release-acceptance.yml','utf8'));
assert.equal(workflow.permissions.contents,'read');
assert.deepEqual(workflow.jobs.decision.needs,['static','database','security']);
assert.equal(workflow.jobs.decision.if,'always()');
assert.deepEqual(workflow.jobs.static.strategy.matrix.node,[22,24]);
assert.equal(workflow.jobs.security.outputs.status,'${{ steps.security-policy.outputs.status }}');
assert(workflow.jobs.security.steps.some(step=>step.id==='security-policy'&&/security-policy-gate/.test(step.run??'')));
assert.equal(workflow.jobs.security.steps.find(step=>step.id==='security-policy').if,"always() && steps.dependencies.outcome == 'success'");
for(const job of Object.values(workflow.jobs))for(const step of job.steps) {
 assert.notEqual(step['continue-on-error'],true,'Required checks cannot be ignored');
 if(step.uses)assert.match(step.uses,/@[a-f0-9]{40}$/,'Pin reviewed action commits');
 assert.ok(!/vercel.*--prod|vercel promote|db push/.test(step.run??''),'Acceptance cannot publish or migrate production');
}
const run=workflow.jobs.database.steps.map(s=>s.run??'').join('\n');
assert.match(run,/run-release-acceptance\.mjs/);assert.match(run,/chromium webkit/);assert.match(run,/pwa-mobile-browser-smoke/);
assert.equal(JSON.parse(readFileSync('vercel.json','utf8')).git.deploymentEnabled,false);
console.log('PASS release workflow structure, mandatory decision, action pins and hosting hold');
