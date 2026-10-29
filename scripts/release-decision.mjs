import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewedAffectedNodes, validatePackageInputs, validateRiskRegister } from './security-policy-gate.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function acceptedIds(outputs) {
  const parsed = typeof outputs?.acceptedRiskIds === 'string' ? JSON.parse(outputs.acceptedRiskIds) : outputs?.acceptedRiskIds;
  assert.ok(Array.isArray(parsed) && parsed.every(id => typeof id === 'string'), 'Security job must return accepted risk IDs');
  return parsed;
}

export function verifySecurityAcceptance(outputs, policyBytes, lockBytes, manifestBytes, commit) {
  assert.ok(outputs?.status === 'PASS' || outputs?.status === 'PASS WITH ACCEPTED RISKS',
    'Actual security policy decision required');
  assert.match(commit ?? '', /^[a-f0-9]{40}$/, 'Exact release checkout SHA required');
  assert.equal(outputs.commit, commit, 'Security job verified another commit');
  assert.equal(outputs.policySha256, sha(policyBytes), 'Security policy changed after verification');
  assert.equal(outputs.lockSha256, sha(lockBytes), 'Dependency lock changed after verification');
  assert.equal(outputs.manifestSha256, sha(manifestBytes), 'Package manifest changed after verification');
  const policy = JSON.parse(policyBytes);
  const risks = validateRiskRegister(policy);
  const { lock } = validatePackageInputs(lockBytes, manifestBytes);
  const affected = risks.filter(row => reviewedAffectedNodes(lock, row).length > 0);
  assert.ok(affected.every(row => row.status === 'accepted'), 'A remediated advisory returned in the release lock');
  const ids = acceptedIds(outputs);
  if (outputs.status === 'PASS') {
    assert.equal(outputs.npmAudit, 'PASS', 'Clean security decision requires clean raw npm audit');
    assert.deepEqual(ids, [], 'Clean security decision cannot contain accepted findings');
  } else {
    assert.equal(outputs.npmAudit, 'FAIL', 'Accepted findings must retain the raw npm audit FAIL');
    assert.ok(ids.length > 0 && new Set(ids).size === ids.length, 'Accepted-risk decision requires unique active advisory IDs');
    const accepted = new Set(risks.filter(row => row.status === 'accepted').map(row => row.id));
    assert.ok(ids.every(id => accepted.has(id)), 'Release decision references an unaccepted or remediated advisory');
  }
  assert.deepEqual([...ids].sort(), affected.map(row => row.id).sort(), 'Security findings do not match known affected lock nodes');
  return { status: outputs.status, npmAudit: outputs.npmAudit, acceptedRiskIds: ids,
    commit,
    policySha256: outputs.policySha256, lockSha256: outputs.lockSha256, manifestSha256: outputs.manifestSha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = JSON.parse(process.env.ACCEPTANCE_RESULTS ?? '{}'), checks = {};
  for (const name of ['static', 'database', 'security']) {
    checks[name] = results[name]?.result;
    assert.equal(checks[name], 'success', 'Required release job ' + name + ' did not succeed');
  }
  const security = verifySecurityAcceptance(results.security.outputs,
    readFileSync('scripts/security-policy.json'), readFileSync('package-lock.json'), readFileSync('package.json'), process.env.ACCEPTANCE_COMMIT);
  assert.match(process.env.ACCEPTANCE_COMMIT ?? '', /^[a-f0-9]{40}$/);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), process.env.ACCEPTANCE_COMMIT,
    'Receipt must identify the tested checkout');
  mkdirSync('.expo/release-acceptance', { recursive: true });
  writeFileSync('.expo/release-acceptance/acceptance.json', JSON.stringify({
    commit: process.env.ACCEPTANCE_COMMIT, checks, security, decision: 'PASS',
    runUrl: process.env.ACCEPTANCE_RUN_URL, manifestSha256: sha(readFileSync('docs/release/manifest.json')),
  }, null, 2) + '\n');
}
