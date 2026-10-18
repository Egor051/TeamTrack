import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { AUDIT_ARGS, auditGraphSha256, evaluatePolicy, fetchUpstream, parseAudit, runGate, verifyBundles } from '../scripts/security-policy-gate.mjs';

const root = resolve(import.meta.dirname, '..');
const policy = JSON.parse(readFileSync(join(root, 'scripts/security-policy.json'), 'utf8'));
const raw = readFileSync(join(root, 'tests/fixtures/security-policy-audit.json'), 'utf8');
const lockBytes = readFileSync(join(root, 'package-lock.json')), manifestBytes = readFileSync(join(root, 'package.json'));
const before = Date.parse('2026-10-25T20:58:59.999Z'), expires = Date.parse('2026-10-25T20:59:00.000Z');
const upstream = () => Object.fromEntries(policy.advisories.map(row => [row.id, {
  advisory: { ghsa_id: row.id, type: 'reviewed', severity: 'high', withdrawn_at: null, updated_at: row.advisoryUpdatedAt,
    vulnerabilities: [{ package: { ecosystem: 'npm', name: row.package }, vulnerable_version_range: row.range, first_patched_version: null }] },
  release: { name: row.package, version: row.version },
}]));
const input = (overrides = {}) => ({ raw, exitCode: 1, policy: structuredClone(policy), lockBytes, manifestBytes, upstream: upstream(), now: before, ...overrides });
const changedAudit = change => {
  const report = JSON.parse(raw); change(report);
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const row of Object.values(report.vulnerabilities)) { counts[row.severity]++; counts.total++; }
  report.metadata.vulnerabilities = counts;
  return JSON.stringify(report);
};
const clean = () => changedAudit(report => { report.vulnerabilities = {}; });
function bundleFixture(directory) {
  const paths = {};
  for (const platform of ['web', 'android', 'ios']) {
    const path = join(directory, '_expo/static/js', platform); mkdirSync(path, { recursive: true });
    const bundle = join(path, platform === 'web' ? 'entry.js' : 'entry.hbc');
    writeFileSync(bundle, 'synthetic bundle');
    paths[platform] = bundle + '.map';
    writeFileSync(paths[platform], JSON.stringify({ version: 3, sources: ['src/app/index.tsx'] }));
  }
  return paths;
}
const metadataFetch = async url => {
  const row = policy.advisories.find(row => url.includes(row.id) || url.includes('/' + row.package + '/latest'));
  return new Response(JSON.stringify(upstream()[row.id][url.includes('api.github.com') ? 'advisory' : 'release']));
};

describe('owner-approved tooling security policy', () => {
  it('permits only the two approved GHSA roots and their exact reviewed meta graph; keeps audit FAIL', () => {
    const result = evaluatePolicy(input());
    expect(result.status).toBe('PASS WITH APPROVED EXCEPTION');
    expect(result.npmAudit).toBe('FAIL'); expect(result.counts.total).toBe(18);
    expect(result.advisoryIds).toEqual(['GHSA-86w9-cpqp-85rv', 'GHSA-vfj7-8cjw-p6xm']);
    expect(policy.expiresAt).toBe('2026-10-25T20:59:00.000Z');
    expect(expires).toBe(Date.UTC(2026, 9, 25, 20, 59));
  });
  it.each(['high', 'critical', 'moderate', 'low', 'info'])('blocks a new %s vulnerability, regardless of severity', severity => {
    const newRaw = changedAudit(report => {
      const row = structuredClone(report.vulnerabilities.braces);
      row.name = 'new-package'; row.severity = severity; row.nodes = ['node_modules/new-package']; row.effects = [];
      row.via = [{ ...row.via[0], name: row.name, dependency: row.name, severity, url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz' }];
      report.vulnerabilities[row.name] = row;
    });
    expect(() => evaluatePolicy(input({ raw: newRaw }))).toThrow(/Unknown or changed advisory/);
  });
  it.each(['url', 'source', 'range'])('blocks changed advisory %s even under the same package name', field => {
    const newRaw = changedAudit(report => { report.vulnerabilities.braces.via[0][field] = field === 'source' ? 999999 : 'unapproved'; });
    expect(() => evaluatePolicy(input({ raw: newRaw }))).toThrow(/Unknown or changed advisory/);
  });
  it('blocks a changed meta dependency chain even if it still reaches an approved advisory', () => {
    const newRaw = changedAudit(report => { report.vulnerabilities.expo.via.push('braces'); });
    expect(() => evaluatePolicy(input({ raw: newRaw }))).toThrow(/dependency chain changed/);
  });
  it('blocks unresolved and unanchored cyclic meta findings', () => {
    expect(() => evaluatePolicy(input({ raw: changedAudit(report => { report.vulnerabilities.expo.via.push('missing'); }) }))).toThrow(/Unresolved/);
    const cycle = changedAudit(report => {
      for (const name of ['cycle-a', 'cycle-b']) report.vulnerabilities[name] = {
        ...structuredClone(report.vulnerabilities.expo), name, effects: [], via: [name === 'cycle-a' ? 'cycle-b' : 'cycle-a'], nodes: ['node_modules/' + name],
      };
    });
    expect(() => evaluatePolicy(input({ raw: cycle }))).toThrow(/Ambiguous/);
  });
  it.each(['lockBytes', 'manifestBytes'])('requires reassessment after %s changes, including a newline-only change', field => {
    expect(() => evaluatePolicy(input({ [field]: Buffer.concat([field === 'lockBytes' ? lockBytes : manifestBytes, Buffer.from('\n')]) }))).toThrow(/changed: risk reassessment/);
  });
  it.each(['{', 'null', '[]', '{}', '{"error":{"code":"EAI_AGAIN"}}'])('fails closed on malformed/incomplete audit: %s', malformed => {
    expect(() => evaluatePolicy(input({ raw: malformed }))).toThrow();
  });
  it('rejects inconsistent counts, missing dependency metadata and unknown report structure', () => {
    const report = JSON.parse(raw); report.metadata.vulnerabilities.high = 0;
    expect(() => parseAudit(JSON.stringify(report), 1)).toThrow(/summary/);
    delete report.metadata.dependencies;
    expect(() => parseAudit(JSON.stringify(report), 1)).toThrow(/metadata/);
    expect(() => parseAudit(JSON.stringify({ ...JSON.parse(raw), unexpected: true }), 1)).toThrow(/structure/);
  });
  it.each([0, 2, null, 'ENOTFOUND'])('rejects unexpected npm audit exit %s', exitCode => {
    expect(() => evaluatePolicy(input({ exitCode }))).toThrow(/exit code/);
  });
  it.each([expires, expires + 1, Date.parse('2026-10-25T23:59:00+03:00')])('expires at the exact UTC boundary %s', now => {
    expect(() => evaluatePolicy(input({ now }))).toThrow(/expired/);
  });
  it('does not accept a local-time expiry or an invalid clock', () => {
    const localPolicy = { ...policy, expiresAt: '2026-10-25T23:59:00' };
    expect(() => evaluatePolicy(input({ policy: localPolicy }))).toThrow(/UTC/);
    expect(() => evaluatePolicy(input({ now: NaN }))).toThrow(/expired/);
  });
  it('requires reassessment when an official patched version or a new release appears', () => {
    const patched = upstream(); patched[policy.advisories[0].id].advisory.vulnerabilities[0].first_patched_version = '3.0.4';
    expect(() => evaluatePolicy(input({ upstream: patched }))).toThrow(/patched version exists/);
    const released = upstream(); released[policy.advisories[1].id].release.version = '1.4.1';
    expect(() => evaluatePolicy(input({ upstream: released }))).toThrow(/release changed/);
  });
  it.each(['withdrawn', 'scope', 'missing', 'updated'])('blocks changed or incomplete official advisory metadata: %s', kind => {
    const metadata = upstream(), entry = metadata[policy.advisories[0].id];
    if (kind === 'withdrawn') entry.advisory.withdrawn_at = '2026-10-20T00:00:00Z';
    if (kind === 'scope') entry.advisory.vulnerabilities[0].vulnerable_version_range = '*';
    if (kind === 'missing') delete entry.advisory.vulnerabilities;
    if (kind === 'updated') entry.advisory.updated_at = '2026-10-20T00:00:00Z';
    expect(() => evaluatePolicy(input({ upstream: metadata }))).toThrow(/advisory/);
  });
  it.each([before, expires + 1])('returns ordinary PASS without an exception for a clean full report at %s', now => {
    expect(evaluatePolicy(input({ raw: clean(), exitCode: 0, now }))).toMatchObject({ status: 'PASS', exception: false, npmAudit: 'PASS' });
    expect(() => evaluatePolicy(input({ raw: clean(), exitCode: 1, now }))).toThrow(/exit code/);
  });
  it('is deterministic for identical inputs and invariant to audit key/set ordering', () => {
    expect(evaluatePolicy(input())).toEqual(evaluatePolicy(input()));
    const reordered = JSON.parse(raw);
    reordered.vulnerabilities = Object.fromEntries(Object.entries(reordered.vulnerabilities).reverse().map(([name, row]) => [name, { ...row, via: row.via.toReversed(), effects: row.effects.toReversed() }]));
    expect(auditGraphSha256(reordered)).toBe(policy.auditGraphSha256);
    expect(evaluatePolicy(input({ raw: JSON.stringify(reordered) }))).toEqual(evaluatePolicy(input()));
  });
  it.each(['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles'])('has the same before/at-expiry result in runner timezone %s', zone => {
    const code = `import {evaluatePolicy} from ${JSON.stringify(pathToFileURL(join(root, 'scripts/security-policy-gate.mjs')).href)};
      import {readFileSync} from 'node:fs';
      const root=${JSON.stringify(root)}, policy=JSON.parse(readFileSync(root+'/scripts/security-policy.json','utf8'));
      const args={raw:readFileSync(root+'/tests/fixtures/security-policy-audit.json','utf8'),exitCode:1,policy,
        lockBytes:readFileSync(root+'/package-lock.json'),manifestBytes:readFileSync(root+'/package.json'),upstream:${JSON.stringify(upstream())}};
      console.log(evaluatePolicy({...args,now:${before}}).status);
      try{evaluatePolicy({...args,now:${expires}});process.exitCode=1;}catch{console.log('expired');}`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ: zone }, encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim().split(/\r?\n/)).toEqual(['PASS WITH APPROVED EXCEPTION', 'expired']);
  });
});

describe('security gate execution and client bundle preconditions', () => {
  it('checks the actual three build platforms and blocks a newly reachable tooling package', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasktrace-risk-bundles-'));
    try {
      const paths = bundleFixture(directory);
      expect(verifyBundles([directory]).map(row => row.platform).sort()).toEqual(['android', 'ios', 'web']);
      for (const source of ['node_modules/braces/lib/expand.js', 'C:\\app\\node_modules\\node-forge\\lib\\rsa.js']) {
        writeFileSync(paths.web, JSON.stringify({ version: 3, sources: [source] }));
        expect(() => verifyBundles([directory])).toThrow(/client bundle/);
      }
      writeFileSync(paths.web, '{'); expect(() => verifyBundles([directory])).toThrow();
      rmSync(paths.web); expect(() => verifyBundles([directory])).toThrow(/Missing/);
    } finally { rmSync(directory, { recursive: true }); }
  });
  it('fails closed for official registry/API errors and malformed official JSON', async () => {
    await expect(fetchUpstream(policy, async () => new Response('registry unavailable', { status: 503 }))).rejects.toThrow(/HTTP 503/);
    await expect(fetchUpstream(policy, async () => new Response('{'))).rejects.toThrow();
  });
  it('preserves the full raw audit, checks official sources without credentials, and fails across expiry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasktrace-risk-run-'));
    try {
      mkdirSync(join(directory, 'scripts')); writeFileSync(join(directory, 'scripts/security-policy.json'), JSON.stringify(policy));
      writeFileSync(join(directory, 'package-lock.json'), lockBytes); writeFileSync(join(directory, 'package.json'), manifestBytes);
      const bundles = join(directory, 'export'); bundleFixture(bundles);
      const calls = [], fetchImpl = async (url, options) => { calls.push({ url, options }); return metadataFetch(url); };
      const audit = async () => ({ stdout: raw, stderr: 'synthetic npm diagnostic', exitCode: 1 });
      const output = join(directory, 'evidence');
      const result = await runGate({ directory, output, bundleDirectories: [bundles], audit, fetchImpl, clock: () => before });
      expect(result.status).toBe('PASS WITH APPROVED EXCEPTION');
      expect(readFileSync(join(output, 'npm-audit.json'), 'utf8')).toBe(raw);
      expect(readFileSync(join(output, 'npm-audit.stderr.log'), 'utf8')).toBe('synthetic npm diagnostic');
      expect(calls).toHaveLength(4); expect(calls.every(call => !('Authorization' in call.options.headers))).toBe(true);
      const ticks = [before, before, expires];
      expect((await runGate({ directory, output, bundleDirectories: [bundles], audit, fetchImpl, clock: () => ticks.shift() ?? expires })).status).toBe('FAIL');
      expect((await runGate({ directory, output, audit, fetchImpl, clock: () => before })).status).toBe('FAIL');
      const malformed = '{"error":{"code":"EAI_AGAIN"}}';
      expect((await runGate({ directory, output, audit: async () => ({ stdout: malformed, stderr: 'registry failed', exitCode: 1 }), clock: () => before })).status).toBe('FAIL');
      expect(readFileSync(join(output, 'npm-audit.json'), 'utf8')).toBe(malformed);
      expect((await runGate({ directory, output, audit: async () => ({ stdout: '', stderr: '', exitCode: 'ENOTFOUND', error: 'npm unavailable' }), clock: () => before })).status).toBe('FAIL');
    } finally { rmSync(directory, { recursive: true }); }
  });
  it('runs the full audit against the official registry without severity suppression', () => {
    expect(AUDIT_ARGS).toEqual(['audit', '--omit=optional', '--json', '--registry=https://registry.npmjs.org/']);
  });
});
