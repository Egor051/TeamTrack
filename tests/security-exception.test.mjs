import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { AUDIT_ARGS, EXCEPTION_DURATION_MS, EXCEPTION_PROFILE, auditGraphSha256, controlsSha256, evaluatePolicy,
  fetchUpstream, lockGraphSha256, runGate, securityJobOutputs, sha256, verifyBundles, verifyExceptionConditions, verifyExportEvidence, verifyInstalledPackages } from '../scripts/security-policy-gate.mjs';
import { CONTROL_FILES, controlFileHashes, exportInputSha256, verifyToolingConditions } from '../scripts/security-tooling-conditions.mjs';
import { exportArguments } from '../scripts/security-export.mjs';
import { verifySecurityAcceptance } from '../scripts/release-decision.mjs';

const root = resolve(import.meta.dirname, '..'), raw = readFileSync(join(root, 'tests/fixtures/security-exception-audit.json'), 'utf8');
const versions = { '@expo/cli': ['node_modules/expo/node_modules/@expo/cli', '57.0.32'],
  '@expo/code-signing-certificates': ['node_modules/@expo/code-signing-certificates', '0.0.6'],
  expo: ['node_modules/expo', '57.0.31'], 'node-forge': ['node_modules/node-forge', '1.4.0'], zod: ['node_modules/zod', '3.25.76'],
  'fast-uri': ['node_modules/fast-uri', '3.1.9'], 'serialize-javascript': ['node_modules/serialize-javascript', '7.1.4'] };
const lock = { packages: Object.fromEntries(Object.values(versions).map(([path, version]) => [path, { version }])) };
const lockBytes = Buffer.from(JSON.stringify(lock)), manifestBytes = Buffer.from('{"name":"synthetic-current-exception-fixture"}');
const start = '2026-10-25T00:00:00.000Z', expiry = '2026-11-08T00:00:00.000Z', before = Date.parse(expiry) - 1;
const policy = { policyVersion: 1, exceptionProfile: EXCEPTION_PROFILE, decision: 'owner-approved-temporary-risk', activated: true,
  approvalReference: 'Synthetic test fixture; not a project-owner approval', startsAt: start, expiresAt: expiry, durationDays: 14,
  lockSha256: sha256(lockBytes), packageManifestSha256: sha256(manifestBytes), lockGraphSha256: lockGraphSha256(lock),
  auditGraphNormalization: 'arborist-derived-metadata-v2', auditGraphSha256: auditGraphSha256(JSON.parse(raw)),
  advisories: Object.values(JSON.parse(raw).vulnerabilities).flatMap(v => v.via.filter(a => typeof a === 'object').map(a => ({
    id: a.url.split('/').at(-1), package: a.name, version: versions[a.name][1], severity: 'high', npmSource: a.source, range: a.range,
    advisoryUpdatedAt: a.name === 'zod' ? '2026-10-23T18:26:52Z' : '2026-10-01T21:09:10Z',
    compatibleMajor: a.name === 'zod' ? 3 : 1, firstPatchedVersion: a.name === 'zod' ? '4.6.6' : null, latestVersion: a.name === 'zod' ? '4.6.7' : '1.4.0',
  }))), reviewedFindingPackages: Object.keys(JSON.parse(raw).vulnerabilities),
  reviewedPackages: Object.entries(versions).map(([name, [path, version]]) => ({ package: name, paths: [{ path, version }] })),
  toolingReleases: [{ package: 'expo', version: '57.0.31', compatibleMajor: 57, compatibleMinor: 0 },
    { package: '@expo/cli', version: '57.0.32', compatibleMajor: 57, compatibleMinor: null }],
  controlHashNormalization: 'utf8-lf-v1', controlFiles: Object.fromEntries(CONTROL_FILES.map(file => [file, null])),
};
policy.controlsSha256 = controlsSha256(policy.controlFiles);
const conditions = () => ({ controlsSha256: policy.controlsSha256, scope: 'isolated-unsigned-static-export', signingInputsAbsent: true, ciCredentialsRestricted: true });
const registry = (name, versions, latest) => ({ name, 'dist-tags': { latest }, versions: Object.fromEntries(versions.map(version => [version, { name, version }])) });
const upstream = () => ({ ...Object.fromEntries(policy.advisories.map(row => [row.id, {
  advisory: { ghsa_id: row.id, type: 'reviewed', withdrawn_at: null, severity: 'high', updated_at: row.advisoryUpdatedAt,
    vulnerabilities: [{ package: { ecosystem: 'npm', name: row.package }, vulnerable_version_range: row.range, first_patched_version: row.firstPatchedVersion }] },
  release: { name: row.package, version: row.latestVersion }, registry: registry(row.package, [...new Set([row.version, row.latestVersion])], row.latestVersion),
}])), tooling: Object.fromEntries(policy.toolingReleases.map(row => [row.package, registry(row.package, [row.version, '58.0.0'], '58.0.0')])) });
const input = overrides => ({ raw, exitCode: 1, policy: structuredClone(policy), lockBytes, manifestBytes, upstream: upstream(), now: before, conditions: conditions(), ...overrides });
function changedAudit(change) {
  const data = JSON.parse(raw); change(data);
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const v of Object.values(data.vulnerabilities)) { counts[v.severity]++; counts.total++; }
  data.metadata.vulnerabilities = counts; return JSON.stringify(data);
}
function tempControls() {
  const directory = mkdtempSync(join(tmpdir(), 'tasktrace-f06-unit-'));
  for (const file of CONTROL_FILES) {
    try { const bytes = readFileSync(join(root, file)); mkdirSync(dirname(join(directory, file)), { recursive: true }); writeFileSync(join(directory, file), bytes); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return directory;
}
function removeFixture(directory) {
  expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
  expect(basename(directory)).toMatch(/^tasktrace-f06-/);
  rmSync(directory, { recursive: true });
}
function installed(directory) {
  for (const [name, [path, version]] of Object.entries(versions)) {
    mkdirSync(join(directory, path), { recursive: true });
    writeFileSync(join(directory, path, 'package.json'), JSON.stringify({ name, version }));
  }
}
function bundles(directory, p) {
  const files = [];
  for (const platform of ['web', 'android', 'ios']) {
    const name = '_expo/static/js/' + platform + '/entry.js'; mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), 'synthetic bundle'); writeFileSync(join(directory, name + '.map'), JSON.stringify({ version: 3, sources: ['src/index.ts'] }));
    for (const file of [name, name + '.map']) files.push({ file, sha256: sha256(readFileSync(join(directory, file))) });
  }
  const project = dirname(directory);
  writeFileSync(join(directory, 'security-export.json'), JSON.stringify({ kind: 'isolated-unsigned-static-export', lockSha256: p.lockSha256,
    packageManifestSha256: p.packageManifestSha256, inputNormalization: 'runtime-export-inputs-lf-v1', inputsSha256: exportInputSha256(project), files }));
}

describe('current fourteen-day exception, exact two advisory only', () => {
  it('preserves raw audit FAIL while accepting exactly the five reviewed HIGH package entries', () => {
    expect(evaluatePolicy(input())).toMatchObject({ status: 'PASS WITH APPROVED EXCEPTION', npmAudit: 'FAIL', startsAt: start, expiresAt: expiry, durationDays: 14,
      advisoryIds: ['GHSA-86w9-cpqp-85rv', 'GHSA-mrhx-c7xc-m3w5'], counts: { high: 5, total: 5, moderate: 0, low: 0 } });
    expect(AUDIT_ARGS).not.toContain('--omit=optional');
  });
  it('returns clean PASS without using an exception, even after the unused exception expires', () => {
    const clean = changedAudit(data => { data.vulnerabilities = {}; });
    expect(evaluatePolicy(input({ raw: clean, exitCode: 0, now: Date.parse(expiry) }))).toMatchObject({ status: 'PASS', exception: false, npmAudit: 'PASS' });
  });
  it.each(['high', 'moderate', 'low', 'critical', 'info'])('rejects a new %s root without widening the approval', severity => {
    const extra = changedAudit(data => { const row = structuredClone(data.vulnerabilities.zod); row.name = 'unapproved'; row.nodes = ['node_modules/unapproved'];
      row.effects = []; row.severity = severity; row.via[0] = { ...row.via[0], name: row.name, dependency: row.name, severity, url: 'https://github.com/advisories/GHSA-new1-new2-new3' }; data.vulnerabilities[row.name] = row; });
    expect(() => evaluatePolicy(input({ raw: extra }))).toThrow(/Unknown or changed advisory/);
  });
  it('rejects changed dependency edges even when every root is still approved', () => {
    expect(() => evaluatePolicy(input({ raw: changedAudit(d => d.vulnerabilities.expo.via.push('node-forge')) }))).toThrow(/dependency chain changed/);
    expect(() => evaluatePolicy(input({ policy: { ...policy, lockGraphSha256: '0'.repeat(64) } }))).toThrow(/lock dependency graph/);
  });
  it.each(['lockBytes', 'manifestBytes'])('rejects changed %s, including whitespace', field => {
    expect(() => evaluatePolicy(input({ [field]: Buffer.concat([field === 'lockBytes' ? lockBytes : manifestBytes, Buffer.from('\n')]) }))).toThrow(/changed: risk reassessment/);
  });
  it('requires reassessment for a root version change even if the caller supplies a new matching lock hash', () => {
    const value = structuredClone(lock); value.packages['node_modules/zod'].version = '3.25.77'; const bytes = Buffer.from(JSON.stringify(value));
    expect(() => evaluatePolicy(input({ lockBytes: bytes, policy: { ...policy, lockSha256: sha256(bytes) } }))).toThrow(/dependency version changed/);
  });
  it('rejects a second nested vulnerable install after lock and graph hashes are recomputed', () => {
    const value = structuredClone(lock); value.packages['node_modules/another/node_modules/zod'] = { version: '3.25.76' }; const bytes = Buffer.from(JSON.stringify(value));
    expect(() => evaluatePolicy(input({ lockBytes: bytes, policy: { ...policy, lockSha256: sha256(bytes), lockGraphSha256: lockGraphSha256(value) } }))).toThrow(/paths or versions changed/);
  });
  it.each([undefined, '', '{', 'null', '{}', '{"error":{"code":"EAI_AGAIN"}}'])('fails closed for absent or malformed audit %s', value => {
    expect(() => evaluatePolicy(input({ raw: value }))).toThrow();
  });
  it.each([Date.parse(expiry), Date.parse(expiry) + 1])('fails at/after the exact 14-day UTC expiry %s', now => {
    expect(Date.parse(expiry) - Date.parse(start)).toBe(EXCEPTION_DURATION_MS);
    expect(() => evaluatePolicy(input({ now }))).toThrow(/expired/);
  });
  it('rejects an exception not yet started, invalid clocks, local timestamps and a duration wider than 14 days', () => {
    expect(() => evaluatePolicy(input({ now: Date.parse(start) - 1 }))).toThrow(/not started/);
    expect(() => evaluatePolicy(input({ now: NaN }))).toThrow();
    expect(() => evaluatePolicy(input({ policy: { ...policy, startsAt: '2026-10-25T03:00:00+03:00' } }))).toThrow(/UTC/);
    expect(() => evaluatePolicy(input({ policy: { ...policy, expiresAt: '2026-11-09T00:00:00.000Z' } }))).toThrow(/exactly 14/);
  });
  it('repeated verification never rewrites the fixed start or expiry', () => {
    const saved = JSON.stringify(policy);
    for (const now of [Date.parse(start), before - 1000, before]) expect(evaluatePolicy(input({ now })).expiresAt).toBe(expiry);
    expect(JSON.stringify(policy)).toBe(saved);
  });
  it('requires a new review for a compatible Zod backport even when npm latest remains major 4', () => {
    const data = upstream(); data[policy.advisories.find(a => a.package === 'zod').id].registry.versions['3.25.77'] = { name: 'zod', version: '3.25.77' };
    expect(() => evaluatePolicy(input({ upstream: data }))).toThrow(/Compatible upstream release changed/);
  });
  it.each(['expo', '@expo/cli'])('requires reassessment for a new compatible %s patch', name => {
    const data = upstream(); data.tooling[name].versions['57.0.33'] = { name, version: '57.0.33' };
    expect(() => evaluatePolicy(input({ upstream: data }))).toThrow(/Compatible Expo tooling release changed/);
  });
  it.each(['updated_at', 'severity', 'first_patched_version', 'range', 'missing'])('rejects changed official advisory %s', field => {
    const data = upstream(), row = data[policy.advisories[0].id].advisory;
    if (field === 'updated_at') row.updated_at = '2026-10-26T00:00:00Z';
    if (field === 'severity') row.severity = 'critical';
    if (field === 'first_patched_version') row.vulnerabilities[0].first_patched_version = '1.4.1';
    if (field === 'range') row.vulnerabilities[0].vulnerable_version_range = '*';
    if (field === 'missing') delete data[policy.advisories[0].id];
    expect(() => evaluatePolicy(input({ upstream: data }))).toThrow();
  });
  it.each(['unknown', 'wildcard', 'legacy'])('rejects advisory allowlist substitution: %s', kind => {
    const value = structuredClone(policy);
    value.advisories[1].id = kind === 'wildcard' ? '*' : kind === 'legacy' ? 'GHSA-vfj7-8cjw-p6xm' : 'GHSA-new1-new2-new3';
    expect(() => evaluatePolicy(input({ policy: value }))).toThrow(/Unapproved exception/);
  });
  it.each([undefined, { ...conditions(), signingInputsAbsent: false }, { ...conditions(), controlsSha256: '0'.repeat(64) }])('rejects unverified compensating measures %j', value => {
    expect(() => evaluatePolicy(input({ conditions: value }))).toThrow(/compensating measures/);
  });
  it('safely rejects unavailable or invalid official metadata', async () => {
    await expect(fetchUpstream(policy, async () => new Response('unavailable', { status: 503 }))).rejects.toThrow(/HTTP 503/);
    await expect(fetchUpstream(policy, async () => new Response('{'))).rejects.toThrow();
  });
});

describe('enforced tooling conditions and fresh artifact provenance', () => {
  it.each(["${{ secrets['TOKEN'] }}", "${{ format('{0}', secrets.TOKEN) }}", '${{ github.token }}'])('rejects privileged workflow input %s', expression => {
    const directory = tempControls();
    try {
      const file = join(directory, '.github/workflows/ci.yml');
      writeFileSync(file, readFileSync(file, 'utf8') + '\n# unreviewed input: ' + expression + '\n');
      expect(() => verifyToolingConditions({ directory, environment: {} })).toThrow(/Privileged\/untrusted CI/);
    } finally { removeFixture(directory); }
  });
  it.each(['version', 'nested duplicate'])('checks the real installed tree instead of trusting a stale npm hidden lock: %s', change => {
    const directory = tempControls();
    try {
      installed(directory); expect(() => verifyInstalledPackages(policy, directory)).not.toThrow();
      if (change === 'version') writeFileSync(join(directory, 'node_modules/fast-uri/package.json'), JSON.stringify({ name: 'fast-uri', version: '3.1.8' }));
      else { const folder = join(directory, 'node_modules/expo/node_modules/zod'); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'zod', version: '3.25.76' })); }
      expect(() => verifyInstalledPackages(policy, directory)).toThrow(/Installed dependency paths or versions/);
    } finally { removeFixture(directory); }
  });
  it.each(['EXPO_TOKEN', 'EAS_ACCESS_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'SUPABASE_SERVICE_ROLE_KEY'])('rejects privileged input %s', name => {
    const directory = tempControls();
    try { expect(() => verifyToolingConditions({ directory, environment: { [name]: 'synthetic-test-input' } })).toThrow(/outside this exception/); }
    finally { removeFixture(directory); }
  });
  it('rejects dynamic/signing config, unreviewed Node preload and network dev server defaults', () => {
    const directory = tempControls();
    try {
      expect(() => verifyToolingConditions({ directory, environment: { NODE_OPTIONS: '--import=unreviewed' } })).toThrow(/preload/);
      const app = JSON.parse(readFileSync(join(directory, 'app.json'))); app.expo.updates = { codeSigningCertificate: './external.pem' };
      writeFileSync(join(directory, 'app.json'), JSON.stringify(app));
      expect(() => verifyToolingConditions({ directory, environment: {} })).toThrow(/Signing config/);
      delete app.expo.updates; writeFileSync(join(directory, 'app.json'), JSON.stringify(app));
      writeFileSync(join(directory, 'app.config.js'), 'export default {};');
      expect(() => verifyToolingConditions({ directory, environment: {} })).toThrow(/Dynamic Expo/);
      rmSync(join(directory, 'app.config.js'));
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'))); manifest.scripts.start = 'expo start'; writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
      expect(() => verifyToolingConditions({ directory, environment: {} })).toThrow(/localhost/);
    } finally { removeFixture(directory); }
  });
  it('binds the reviewed control files and preserves Git LF/CRLF portability', () => {
    const directory = tempControls();
    try {
      const p = { ...policy, controlFiles: controlFileHashes(directory) }; p.controlsSha256 = controlsSha256(p.controlFiles);
      expect(verifyExceptionConditions(p, directory, {}).controlsSha256).toBe(p.controlsSha256);
      const path = join(directory, 'app.json'); writeFileSync(path, readFileSync(path, 'utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
      expect(verifyExceptionConditions(p, directory, {}).controlsSha256).toBe(p.controlsSha256);
      writeFileSync(join(directory, 'scripts/generate-service-worker.mjs'), '// unreviewed code change');
      expect(() => verifyExceptionConditions(p, directory, {})).toThrow(/controls changed/);
    } finally { removeFixture(directory); }
  });
  it.each(['node_modules/zod/index.js', 'node_modules/node-forge/lib/rsa.js'])('blocks client exposure of %s', source => {
    const directory = mkdtempSync(join(tmpdir(), 'tasktrace-f06-bundle-'));
    try { bundles(directory, policy); writeFileSync(join(directory, '_expo/static/js/web/entry.js.map'), JSON.stringify({ version: 3, sources: [source] }));
      expect(() => verifyBundles([directory])).toThrow(/client bundle/);
    } finally { removeFixture(directory); }
  });
  it('rejects unsupported export/signing arguments', () => {
    expect(exportArguments(['--platform', 'web', '--output-dir', 'dist'])).toEqual(['export', '--platform', 'web', '--output-dir', 'dist']);
    expect(() => exportArguments(['--private-key-path', 'external.pem'])).toThrow(/Unsupported/);
    expect(() => exportArguments(['--platform', 'web', '--host', 'lan'])).toThrow();
  });
  it('rejects stale lock fingerprints and altered bundle bytes in export evidence', () => {
    const directory = tempControls();
    try {
      const folder = join(directory, 'export'); bundles(folder, policy);
      expect(() => verifyExportEvidence([folder], directory, policy)).not.toThrow();
      expect(() => verifyExportEvidence([folder], directory, { ...policy, lockSha256: '0'.repeat(64) })).toThrow(/different inputs/);
      writeFileSync(join(folder, '_expo/static/js/web/entry.js'), 'altered');
      expect(() => verifyExportEvidence([folder], directory, policy)).toThrow(/artifact hash changed/);
    } finally { removeFixture(directory); }
  });
  it('runs the full current gate twice without renewing policy and fails if expiry is crossed', async () => {
    const directory = tempControls();
    try {
      writeFileSync(join(directory, 'package-lock.json'), lockBytes);
      installed(directory);
      const manifest = readFileSync(join(directory, 'package.json'));
      const p = { ...policy, packageManifestSha256: sha256(manifest), controlFiles: controlFileHashes(directory) }; p.controlsSha256 = controlsSha256(p.controlFiles);
      writeFileSync(join(directory, 'scripts/security-policy.json'), JSON.stringify(p));
      const folder = join(directory, 'export'); bundles(folder, p);
      const fetchImpl = async url => {
        const data = upstream();
        if (url.includes('api.github.com/')) return new Response(JSON.stringify(data[url.split('/').at(-1)].advisory));
        const path = decodeURIComponent(new URL(url).pathname.slice(1));
        const row = p.advisories.find(row => path === row.package || path === row.package + '/latest');
        return new Response(JSON.stringify(row ? data[row.id][path.endsWith('/latest') ? 'release' : 'registry'] : data.tooling[path]));
      };
      const options = { directory, output: join(directory, 'evidence'), bundleDirectories: [folder], environment: {}, fetchImpl,
        audit: async () => ({ stdout: raw, stderr: 'synthetic diagnostic', exitCode: 1 }), clock: () => before };
      for (let n = 0; n < 2; n++) expect((await runGate(options)).status).toBe('PASS WITH APPROVED EXCEPTION');
      expect(JSON.parse(readFileSync(join(directory, 'scripts/security-policy.json'))).expiresAt).toBe(expiry);
      expect(readFileSync(join(directory, 'evidence/npm-audit.json'), 'utf8')).toBe(raw);
      const ticks = [before, before, Date.parse(expiry)];
      expect((await runGate({ ...options, clock: () => ticks.shift() ?? Date.parse(expiry) })).status).toBe('FAIL');
    } finally { removeFixture(directory); }
  });
});

describe('release acceptance consumes the actual policy decision', () => {
  const bytes = Buffer.from(JSON.stringify(policy));
  const output = status => ({ status, npmAudit: status === 'PASS' ? 'PASS' : 'FAIL', policySha256: sha256(bytes), lockSha256: sha256(lockBytes) });
  it.each(['PASS', 'PASS WITH APPROVED EXCEPTION'])('accepts %s while preserving its raw audit status', status => {
    expect(verifySecurityAcceptance(output(status), bytes, lockBytes, before).status).toBe(status);
    expect(securityJobOutputs(output(status))).toContain('status=' + status + '\n');
  });
  it('does not allow a security job that finished before expiry to authorize a later expired decision', () => {
    expect(() => verifySecurityAcceptance(output('PASS WITH APPROVED EXCEPTION'), bytes, lockBytes, Date.parse(expiry))).toThrow(/expired/);
  });
  it.each(['FAIL', undefined, 'PASS\nunknown=accepted'])('rejects a missing, failed or malformed job decision %s', status => {
    expect(() => verifySecurityAcceptance(output(status), bytes, lockBytes, before)).toThrow(/Actual security policy/);
    if (status !== 'FAIL') expect(() => securityJobOutputs(output(status))).toThrow();
  });
  it('rejects policy/lock drift and false clean-audit classification at the final receipt', () => {
    expect(() => verifySecurityAcceptance({ ...output('PASS'), policySha256: '0'.repeat(64) }, bytes, lockBytes, before)).toThrow(/policy changed/);
    expect(() => verifySecurityAcceptance({ ...output('PASS'), lockSha256: '0'.repeat(64) }, bytes, lockBytes, before)).toThrow(/lock changed/);
    expect(() => verifySecurityAcceptance({ ...output('PASS'), npmAudit: 'FAIL' }, bytes, lockBytes, before)).toThrow(/clean raw audit/);
  });
});
