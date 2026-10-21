// Owner-approved, expiring exception for exactly two tooling advisories.
// This runs the full audit; it never fixes, filters or rewrites its raw output.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const allowedIds = new Map([['GHSA-vfj7-8cjw-p6xm', 'braces'], ['GHSA-86w9-cpqp-85rv', 'node-forge']]);
const levels = ['info', 'low', 'moderate', 'high', 'critical'];
export const AUDIT_ARGS = ['audit', '--omit=optional', '--json', '--registry=https://registry.npmjs.org/'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = value => Array.isArray(value) ? value.map(canonical).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)))
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const reviewedBreakingFixes = [
  { name: 'react-native', version: '0.72.17', isSemVerMajor: true },
  { name: 'react-native-worklets', version: '0.7.4', isSemVerMajor: true },
];
function normalizedFix(name, value) {
  // Arborist keeps the first breaking parent recommendation propagated over
  // its order-dependent internal via Set. These two captured downgrades both
  // leave the supported Expo 57 stack. Frozen-tree/calculator replay proves
  // that only the recommendation changes, not any affected node/advisory.
  // No other name, version, nonbreaking fix or availability flag is ignored.
  return name === '@react-native/metro-config' && reviewedBreakingFixes.some(fix => JSON.stringify(canonical(fix)) === JSON.stringify(canonical(value)))
    ? reviewedBreakingFixes[0] : value;
}
export function auditGraphSha256(report) {
  // npm serializes `via` from all advisories, but `effects` from a separately
  // traversed Vuln.effects Set. Arborist's seen(name@range) short circuit can
  // omit one reverse edge when equal-range metavulns arrive in another order.
  // Fingerprint the complete reverse of via instead. Reject any supplied
  // effects edge which via does not justify. The only other equivalence is
  // the two independently reproduced breaking recommendations above.
  const findings = report.vulnerabilities;
  const reverse = new Map(Object.keys(findings).map(name => [name, []]));
  for (const [name, finding] of Object.entries(findings)) for (const via of finding.via) {
    if (typeof via !== 'string') continue;
    requireThat(reverse.has(via), 'Unresolved meta finding: ' + via);
    reverse.get(via).push(name);
  }
  for (const [name, finding] of Object.entries(findings)) for (const effect of finding.effects)
    requireThat(reverse.get(name).includes(effect), 'Unknown effects edge: ' + name + ' -> ' + effect);
  const normalized = Object.fromEntries(Object.entries(findings).map(([name, finding]) =>
    [name, { ...finding, effects: [...new Set(reverse.get(name))], fixAvailable: normalizedFix(name, finding.fixAvailable) }]));
  return sha256(JSON.stringify(canonical(normalized)));
}

export function parseAudit(raw, exitCode) {
  const report = JSON.parse(raw);
  requireThat(object(report) && !report.error && report.auditReportVersion === 2 && object(report.vulnerabilities)
    && object(report.metadata?.vulnerabilities), 'Invalid/incomplete npm audit report or registry error');
  requireThat(exactKeys(report, ['auditReportVersion', 'vulnerabilities', 'metadata']), 'Unknown audit report structure');
  requireThat(exactKeys(report.metadata.dependencies, ['prod', 'dev', 'optional', 'peer', 'peerOptional', 'total'])
    && Object.values(report.metadata.dependencies).every(value => Number.isSafeInteger(value) && value >= 0)
    && report.metadata.dependencies.total > 0, 'Incomplete dependency audit metadata');
  const counts = Object.fromEntries(levels.map(level => [level, 0]));
  for (const [name, finding] of Object.entries(report.vulnerabilities)) {
    requireThat(exactKeys(finding, ['name', 'severity', 'isDirect', 'via', 'effects', 'range', 'nodes', 'fixAvailable'])
      && finding.name === name && levels.includes(finding.severity) && typeof finding.isDirect === 'boolean'
      && typeof finding.range === 'string' && strings(finding.nodes) && finding.nodes.length > 0
      && strings(finding.effects) && Array.isArray(finding.via) && finding.via.length > 0,
    'Unknown vulnerability structure: ' + name);
    requireThat(typeof finding.fixAvailable === 'boolean' || (exactKeys(finding.fixAvailable, ['name', 'version', 'isSemVerMajor'])
      && typeof finding.fixAvailable.name === 'string' && typeof finding.fixAvailable.version === 'string'
      && typeof finding.fixAvailable.isSemVerMajor === 'boolean'), 'Unknown remediation structure: ' + name);
    counts[finding.severity]++;
  }
  const summary = report.metadata.vulnerabilities, total = Object.keys(report.vulnerabilities).length;
  requireThat(exactKeys(summary, [...levels, 'total']) && levels.every(level => summary[level] === counts[level])
    && summary.total === total, 'Audit summary does not match findings');
  requireThat(exitCode === (total ? 1 : 0), 'npm audit failed or returned an inconsistent exit code');
  return report;
}

function validatePolicy(policy, lockBytes, manifestBytes) {
  requireThat(policy.policyVersion === 1 && policy.decision === 'owner-approved-temporary-risk'
    && policy.auditGraphNormalization === 'arborist-derived-metadata-v2'
    && Array.isArray(policy.advisories) && policy.advisories.length === 2
    && new Set(policy.advisories.map(row => row.id)).size === 2
    && policy.advisories.every(row => allowedIds.get(row.id) === row.package), 'Unapproved exception policy');
  requireThat(typeof policy.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(policy.expiresAt)
    && new Date(policy.expiresAt).toISOString() === policy.expiresAt, 'Expiry must be an explicit UTC instant');
  requireThat(sha256(lockBytes) === policy.lockSha256, 'Lockfile changed: risk reassessment required');
  requireThat(sha256(manifestBytes) === policy.packageManifestSha256, 'Package manifest changed: risk reassessment required');
  const lock = JSON.parse(lockBytes);
  for (const row of policy.advisories) requireThat(lock.packages?.['node_modules/' + row.package]?.version === row.version,
    'Reviewed dependency version changed: ' + row.package);
}

function verifyFindingScope(report, policy) {
  const reached = new Map(Object.keys(report.vulnerabilities).map(name => [name, new Set()]));
  for (const [name, finding] of Object.entries(report.vulnerabilities)) {
    for (const via of finding.via) {
      if (typeof via === 'string') {
        requireThat(reached.has(via), 'Unresolved meta finding: ' + via);
      } else {
        const approved = policy.advisories.find(row => via?.url === 'https://github.com/advisories/' + row.id);
        requireThat(approved && name === approved.package && via.name === name && via.dependency === name
          && via.source === approved.npmSource && via.range === approved.range && via.severity === 'high',
        'Unknown or changed advisory: ' + (via?.url || name));
        reached.get(name).add(approved.id);
      }
    }
  }
  // npm's reviewed graph contains Metro/RN cycles. A cycle is acceptable only
  // when it has a path to an approved root; an unanchored cycle is ambiguous.
  let changed;
  do {
    changed = false;
    for (const [name, finding] of Object.entries(report.vulnerabilities)) for (const via of finding.via) {
      if (typeof via !== 'string') continue;
      for (const id of reached.get(via)) if (!reached.get(name).has(id)) { reached.get(name).add(id); changed = true; }
    }
  } while (changed);
  requireThat([...reached.values()].every(ids => ids.size > 0), 'Ambiguous meta finding without an approved advisory path');
  requireThat(strings(policy.reviewedFindingPackages)
    && JSON.stringify([...policy.reviewedFindingPackages].sort()) === JSON.stringify(Object.keys(report.vulnerabilities).sort()),
  'Reviewed finding package set changed: risk reassessment required');
  requireThat(auditGraphSha256(report) === policy.auditGraphSha256, 'Audit dependency chain changed: risk reassessment required');
}

export function verifyUpstream(policy, upstream) {
  for (const row of policy.advisories) {
    const entry = upstream?.[row.id], advisory = entry?.advisory, release = entry?.release;
    requireThat(advisory?.ghsa_id === row.id && advisory.type === 'reviewed' && advisory.withdrawn_at === null
      && advisory.severity === 'high' && advisory.updated_at === row.advisoryUpdatedAt
      && Array.isArray(advisory.vulnerabilities) && advisory.vulnerabilities.length === 1,
    'Official advisory changed or is unavailable: ' + row.id);
    const vulnerability = advisory.vulnerabilities[0];
    requireThat(vulnerability.package?.ecosystem === 'npm' && vulnerability.package.name === row.package
      && typeof vulnerability.vulnerable_version_range === 'string'
      && vulnerability.vulnerable_version_range.replace(/\s/g, '') === row.range, 'Official advisory scope changed: ' + row.id);
    requireThat(vulnerability.first_patched_version === null, 'Official patched version exists: reassess and update ' + row.package);
    requireThat(release?.name === row.package && release.version === row.version,
      'Official package release changed: reassessment required for ' + row.package);
  }
}

export function evaluatePolicy({ raw, exitCode, policy, lockBytes, manifestBytes, upstream, now }) {
  const report = parseAudit(raw, exitCode);
  validatePolicy(policy, lockBytes, manifestBytes);
  if (report.metadata.vulnerabilities.total === 0) return { status: 'PASS', exception: false, npmAudit: 'PASS', counts: report.metadata.vulnerabilities };
  requireThat(Number.isFinite(now) && now < Date.parse(policy.expiresAt), 'Approved exception expired; explicit new owner decision or verified fix required');
  verifyFindingScope(report, policy);
  verifyUpstream(policy, upstream);
  return { status: 'PASS WITH APPROVED EXCEPTION', exception: true, npmAudit: 'FAIL', counts: report.metadata.vulnerabilities,
    advisoryIds: policy.advisories.map(row => row.id).sort(), expiresAt: policy.expiresAt };
}

export function verifyBundles(directories) {
  requireThat(directories.length > 0, 'Web/Android/iOS source maps are required for the tooling exception');
  const maps = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      requireThat(!entry.isSymbolicLink(), 'Unexpected symlink in build evidence');
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.map')) {
        const platform = path.replace(/\\/g, '/').match(/\/_expo\/static\/js\/(web|android|ios)\//)?.[1];
        if (!platform) continue;
        const bytes = readFileSync(path), data = JSON.parse(bytes);
        requireThat(data.version === 3 && strings(data.sources) && data.sources.length > 0
          && existsSync(path.slice(0, -4)), 'Incomplete build/source map evidence: ' + path);
        requireThat(!data.sources.some(source => /(^|[\\/])(braces|node-forge)([\\/]|$)/.test(source)),
          'Tooling advisory package is present in the ' + platform + ' client bundle');
        maps.push({ platform, map: path, sources: data.sources.length, mapSha256: sha256(bytes), bundleSha256: sha256(readFileSync(path.slice(0, -4))) });
      }
    }
  };
  for (const directory of directories) walk(resolve(directory));
  requireThat(['web', 'android', 'ios'].every(platform => maps.some(row => row.platform === platform)), 'Missing Web/Android/iOS bundle proof');
  return maps.sort((a, b) => compare(a.map, b.map));
}

export function runNpmAudit(directory) {
  const windows = process.platform === 'win32';
  return new Promise(resolveRun => execFile(windows ? process.env.ComSpec || 'cmd.exe' : 'npm',
    windows ? ['/d', '/s', '/c', 'npm', ...AUDIT_ARGS] : AUDIT_ARGS,
    { cwd: directory, windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
    (error, stdout, stderr) => resolveRun({ stdout, stderr, exitCode: error ? error.code : 0,
      error: error && typeof error.code !== 'number' ? error.message : null })));
}

export async function fetchUpstream(policy, fetchImpl = fetch, capture = () => undefined) {
  const upstream = Object.fromEntries(policy.advisories.map(row => [row.id, {}]));
  const results = await Promise.allSettled(policy.advisories.flatMap(row => [
    ['advisory', 'https://api.github.com/advisories/' + row.id], ['release', 'https://registry.npmjs.org/' + row.package + '/latest'],
  ].map(async ([kind, url]) => {
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: {
      Accept: kind === 'advisory' ? 'application/vnd.github+json' : 'application/json', 'User-Agent': 'TaskTrace-security-policy',
    } });
    requireThat(response.ok, 'Official security metadata unavailable: HTTP ' + response.status + ' ' + url);
    const raw = await response.text();
    capture(row.package + '-' + kind + '.json', raw);
    upstream[row.id][kind] = JSON.parse(raw);
  })));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return upstream;
}

export async function runGate({ directory = root, output = resolve(directory, '.expo/security-policy'), bundleDirectories = [],
  audit = runNpmAudit, fetchImpl = fetch, clock = Date.now } = {}) {
  mkdirSync(output, { recursive: true });
  const summary = { status: 'FAIL', npmAudit: 'ERROR', generatedAt: new Date(clock()).toISOString() };
  const save = (name, raw) => writeFileSync(resolve(output, name), raw);
  try {
    const result = await audit(directory);
    // Preserve raw bytes/text even for malformed JSON and registry failures.
    save('npm-audit.json', result.stdout || ''); save('npm-audit.stderr.log', result.stderr || '');
    summary.npmExitCode = result.exitCode;
    requireThat(!result.error, 'npm audit execution failed: ' + result.error);
    const report = parseAudit(result.stdout, result.exitCode);
    summary.npmAudit = report.metadata.vulnerabilities.total ? 'FAIL' : 'PASS';
    summary.counts = report.metadata.vulnerabilities;
    const policy = JSON.parse(readFileSync(resolve(directory, 'scripts/security-policy.json'), 'utf8'));
    const lockBytes = readFileSync(resolve(directory, 'package-lock.json')), manifestBytes = readFileSync(resolve(directory, 'package.json'));
    validatePolicy(policy, lockBytes, manifestBytes);
    const upstream = report.metadata.vulnerabilities.total ? await fetchUpstream(policy, fetchImpl, save) : {};
    const decision = evaluatePolicy({ raw: result.stdout, exitCode: result.exitCode, policy, lockBytes, manifestBytes, upstream, now: clock() });
    const bundles = decision.exception ? verifyBundles(bundleDirectories) : [];
    requireThat(!decision.exception || clock() < Date.parse(policy.expiresAt), 'Approved exception expired during verification');
    Object.assign(summary, decision, { lockSha256: sha256(lockBytes), auditGraphSha256: auditGraphSha256(report), bundles });
  } catch (error) { summary.error = error instanceof Error ? error.message : String(error); }
  save('policy-result.json', JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directories = [];
  for (let index = 2; index < process.argv.length; index += 2) {
    requireThat(process.argv[index] === '--bundles' && process.argv[index + 1], 'Usage: node scripts/security-policy-gate.mjs --bundles <export-directory>');
    directories.push(process.argv[index + 1]);
  }
  const result = await runGate({ bundleDirectories: directories });
  console.log('npm audit: ' + result.npmAudit + ' (raw report: .expo/security-policy/npm-audit.json)');
  console.log('Security policy gate: ' + result.status + (result.expiresAt ? '; expires ' + result.expiresAt : ''));
  if (result.error) console.error(result.error);
  process.exitCode = result.status === 'FAIL' ? 1 : 0;
}
