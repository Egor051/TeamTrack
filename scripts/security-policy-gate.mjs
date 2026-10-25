// Owner-approved, expiring exception for exactly two tooling advisories.
// This runs the full audit; it never fixes, filters or rewrites its raw output.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROL_FILES, controlFileHashes, exportInputSha256, verifyToolingConditions } from './security-tooling-conditions.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const allowedIds = new Map([['GHSA-vfj7-8cjw-p6xm', 'braces'], ['GHSA-86w9-cpqp-85rv', 'node-forge']]);
export const EXCEPTION_PROFILE = 'expo57-unsigned-tooling-20261025';
export const EXCEPTION_DURATION_MS = 14 * 24 * 60 * 60 * 1000;
const currentIds = new Map([['GHSA-86w9-cpqp-85rv', 'node-forge'], ['GHSA-mrhx-c7xc-m3w5', 'zod']]);
const levels = ['info', 'low', 'moderate', 'high', 'critical'];
export const AUDIT_ARGS = ['audit', '--json', '--registry=https://registry.npmjs.org/'];
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = value => Array.isArray(value) ? value.map(canonical).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)))
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digestObject = value => sha256(JSON.stringify(canonical(value)));
export const lockGraphSha256 = lock => digestObject(lock.packages);
export const controlsSha256 = files => digestObject(files);
const currentProfile = policy => policy.exceptionProfile === EXCEPTION_PROFILE;
const utcInstant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
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
  const approved = currentProfile(policy) ? currentIds : allowedIds;
  requireThat(policy.policyVersion === 1 && policy.decision === 'owner-approved-temporary-risk'
    && (policy.exceptionProfile === undefined || currentProfile(policy))
    && policy.auditGraphNormalization === 'arborist-derived-metadata-v2'
    && Array.isArray(policy.advisories) && policy.advisories.length === 2
    && new Set(policy.advisories.map(row => row.id)).size === 2
    && policy.advisories.every(row => approved.get(row.id) === row.package), 'Unapproved exception policy');
  requireThat(utcInstant(policy.expiresAt), 'Expiry must be an explicit UTC instant');
  requireThat(sha256(lockBytes) === policy.lockSha256, 'Lockfile changed: risk reassessment required');
  requireThat(sha256(manifestBytes) === policy.packageManifestSha256, 'Package manifest changed: risk reassessment required');
  const lock = JSON.parse(lockBytes);
  for (const row of policy.advisories) requireThat(lock.packages?.['node_modules/' + row.package]?.version === row.version,
    'Reviewed dependency version changed: ' + row.package);
  if (currentProfile(policy)) {
    requireThat(policy.activated === true && typeof policy.approvalReference === 'string' && policy.approvalReference.length > 0,
      'Explicit owner-approved configuration has not been activated');
    requireThat(utcInstant(policy.startsAt) && policy.durationDays === 14
      && Date.parse(policy.expiresAt) - Date.parse(policy.startsAt) === EXCEPTION_DURATION_MS, 'Exception must last exactly 14 days in UTC');
    requireThat(lockGraphSha256(lock) === policy.lockGraphSha256, 'Reviewed lock dependency graph changed');
    const names = ['@expo/cli', '@expo/code-signing-certificates', 'expo', 'node-forge', 'zod', 'fast-uri', 'serialize-javascript'];
    requireThat(Array.isArray(policy.reviewedPackages) && policy.reviewedPackages.length === names.length
      && JSON.stringify(policy.reviewedPackages.map(p => p.package).sort()) === JSON.stringify(names.sort()), 'Reviewed package/version scope changed');
    for (const row of policy.reviewedPackages) {
      const paths = Object.entries(lock.packages).filter(([path]) => path === 'node_modules/' + row.package || path.endsWith('/node_modules/' + row.package))
        .map(([path, value]) => ({ path, version: value.version }));
      requireThat(paths.length > 0 && digestObject(paths) === digestObject(row.paths), 'Reviewed dependency paths or versions changed: ' + row.package);
    }
    for (const row of policy.advisories) requireThat(row.severity === 'high'
      && row.compatibleMajor === (row.package === 'zod' ? 3 : 1)
      && row.firstPatchedVersion === (row.package === 'zod' ? '4.6.6' : null)
      && typeof row.latestVersion === 'string', 'Unreviewed upstream compatibility assumptions');
    requireThat(Array.isArray(policy.toolingReleases) && policy.toolingReleases.length === 2
      && policy.toolingReleases.some(r => r.package === 'expo' && r.version === lock.packages['node_modules/expo'].version && r.compatibleMajor === 57 && r.compatibleMinor === 0)
      && policy.toolingReleases.some(r => r.package === '@expo/cli' && r.version === lock.packages['node_modules/expo/node_modules/@expo/cli'].version && r.compatibleMajor === 57 && r.compatibleMinor === null),
    'Tooling compatibility scope changed');
    requireThat(exactKeys(policy.controlFiles, CONTROL_FILES) && policy.controlHashNormalization === 'utf8-lf-v1'
      && controlsSha256(policy.controlFiles) === policy.controlsSha256, 'Incomplete compensating control fingerprint');
  }
}

export function verifyExceptionConditions(policy, directory = root, environment = process.env) {
  const conditions = verifyToolingConditions({ directory, environment });
  const files = controlFileHashes(directory);
  requireThat(digestObject(files) === digestObject(policy.controlFiles), 'Compensating controls changed: explicit risk reassessment required');
  return { ...conditions, controlsSha256: controlsSha256(files) };
}

export function verifyInstalledPackages(policy, directory = root) {
  const found = new Map(policy.reviewedPackages.map(row => [row.package, []]));
  const walk = (modules, prefix) => {
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || !entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const names = entry.name.startsWith('@') ? readdirSync(resolve(modules, entry.name)).map(name => entry.name + '/' + name) : [entry.name];
      for (const name of names) {
        const folder = resolve(modules, name), path = prefix + '/' + name;
        requireThat(!lstatSync(folder).isSymbolicLink(), 'Unreviewed installed dependency symlink');
        if (found.has(name)) {
          const value = JSON.parse(readFileSync(resolve(folder, 'package.json'), 'utf8'));
          requireThat(value.name === name, 'Installed package identity changed: ' + name);
          found.get(name).push({ path, version: value.version });
        }
        if (existsSync(resolve(folder, 'node_modules'))) walk(resolve(folder, 'node_modules'), path + '/node_modules');
      }
    }
  };
  walk(resolve(directory, 'node_modules'), 'node_modules');
  for (const row of policy.reviewedPackages) requireThat(digestObject(found.get(row.package)) === digestObject(row.paths),
    'Installed dependency paths or versions changed: ' + row.package);
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
    requireThat(vulnerability.first_patched_version === (currentProfile(policy) ? row.firstPatchedVersion : null),
      'Official patched version exists or changed: reassess and update ' + row.package);
    requireThat(release?.name === row.package && release.version === (currentProfile(policy) ? row.latestVersion : row.version),
      'Official package release changed: reassessment required for ' + row.package);
    if (currentProfile(policy)) requireThat(latestCompatible(entry.registry, row) === row.version,
      'Compatible upstream release changed: reassessment required for ' + row.package);
  }
  if (currentProfile(policy)) for (const row of policy.toolingReleases)
    requireThat(latestCompatible(upstream?.tooling?.[row.package], row) === row.version,
      'Compatible Expo tooling release changed: reassessment required for ' + row.package);
}

function latestCompatible(registry, row) {
  requireThat(registry?.name === row.package && object(registry.versions) && typeof registry['dist-tags']?.latest === 'string',
    'Official compatible release metadata unavailable: ' + row.package);
  const versions = Object.keys(registry.versions).filter(version => {
    if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
    const [major, minor] = version.split('.').map(Number);
    return major === row.compatibleMajor && (row.compatibleMinor == null || minor === row.compatibleMinor);
  }).sort((a, b) => {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  const version = versions.at(-1);
  requireThat(version && registry.versions[version]?.name === row.package && registry.versions[version].version === version,
    'Incomplete compatible release metadata: ' + row.package);
  return version;
}

export function evaluatePolicy({ raw, exitCode, policy, lockBytes, manifestBytes, upstream, now, conditions }) {
  const report = parseAudit(raw, exitCode);
  validatePolicy(policy, lockBytes, manifestBytes);
  if (report.metadata.vulnerabilities.total === 0) return { status: 'PASS', exception: false, npmAudit: 'PASS', counts: report.metadata.vulnerabilities };
  requireThat(Number.isFinite(now) && now < Date.parse(policy.expiresAt), 'Approved exception expired; explicit new owner decision or verified fix required');
  if (currentProfile(policy)) {
    requireThat(now >= Date.parse(policy.startsAt), 'Approved exception has not started');
    requireThat(conditions?.controlsSha256 === policy.controlsSha256 && conditions.scope === 'isolated-unsigned-static-export'
      && conditions.signingInputsAbsent === true && conditions.ciCredentialsRestricted === true, 'Mandatory compensating measures are unverified or violated');
  }
  verifyFindingScope(report, policy);
  verifyUpstream(policy, upstream);
  return { status: 'PASS WITH APPROVED EXCEPTION', exception: true, npmAudit: 'FAIL', counts: report.metadata.vulnerabilities,
    advisoryIds: policy.advisories.map(row => row.id).sort(), ...(currentProfile(policy) ? { startsAt: policy.startsAt, durationDays: 14 } : {}), expiresAt: policy.expiresAt };
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
        requireThat(!data.sources.some(source => /(^|[\\/])(braces|node-forge|zod|fast-uri|serialize-javascript)([\\/]|$)/.test(source)),
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
  const requests = policy.advisories.flatMap(row => [
    ['advisory', 'https://api.github.com/advisories/' + row.id], ['release', 'https://registry.npmjs.org/' + row.package + '/latest'],
    ...(currentProfile(policy) ? [['registry', 'https://registry.npmjs.org/' + row.package]] : []),
  ].map(([kind, url]) => ({ row, kind, url })));
  if (currentProfile(policy)) {
    upstream.tooling = {};
    for (const row of policy.toolingReleases) requests.push({ row, kind: 'tooling', url: 'https://registry.npmjs.org/' + encodeURIComponent(row.package) });
  }
  const results = await Promise.allSettled(requests.map(async ({ row, kind, url }) => {
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: {
      Accept: kind === 'advisory' ? 'application/vnd.github+json' : 'application/json', 'User-Agent': 'TaskTrace-security-policy',
    } });
    requireThat(response.ok, 'Official security metadata unavailable: HTTP ' + response.status + ' ' + url);
    const raw = await response.text();
    capture(row.package.replaceAll('/', '-') + '-' + kind + '.json', raw);
    if (kind === 'tooling') upstream.tooling[row.package] = JSON.parse(raw);
    else upstream[row.id][kind] = JSON.parse(raw);
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return upstream;
}

export function verifyExportEvidence(directories, directory, policy) {
  const inputs = exportInputSha256(directory);
  const bundles = verifyBundles(directories);
  for (const folder of directories) {
    const metadata = JSON.parse(readFileSync(resolve(folder, 'security-export.json'), 'utf8'));
    requireThat(metadata.kind === 'isolated-unsigned-static-export' && metadata.inputNormalization === 'runtime-export-inputs-lf-v1'
      && metadata.inputsSha256 === inputs && metadata.lockSha256 === policy.lockSha256 && metadata.packageManifestSha256 === policy.packageManifestSha256,
    'Build evidence belongs to different inputs/lock/manifest');
    requireThat(Array.isArray(metadata.files) && metadata.files.length > 0, 'Missing export artifact hashes');
    const known = new Set();
    for (const row of metadata.files) {
      requireThat(typeof row.file === 'string' && /^_expo\/static\/js\/(?:web|android|ios)\/[a-zA-Z0-9_./-]+$/.test(row.file)
        && !row.file.split('/').includes('..') && !known.has(row.file), 'Invalid export artifact path');
      known.add(row.file);
      requireThat(sha256(readFileSync(resolve(folder, row.file))) === row.sha256, 'Export artifact hash changed: ' + row.file);
    }
    for (const row of bundles.filter(row => row.map.startsWith(resolve(folder) + (process.platform === 'win32' ? '\\' : '/')))) {
      const file = row.map.slice(resolve(folder).length + 1).replaceAll('\\', '/');
      requireThat(known.has(file) && known.has(file.slice(0, -4)), 'Unrecorded client bundle/source map');
    }
  }
}

export async function runGate({ directory = root, output = resolve(directory, '.expo/security-policy'), bundleDirectories = [],
  audit = runNpmAudit, fetchImpl = fetch, clock = Date.now, environment = process.env } = {}) {
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
    if (currentProfile(policy)) verifyInstalledPackages(policy, directory);
    const conditions = report.metadata.vulnerabilities.total && currentProfile(policy) ? verifyExceptionConditions(policy, directory, environment) : undefined;
    const upstream = report.metadata.vulnerabilities.total ? await fetchUpstream(policy, fetchImpl, save) : {};
    const decision = evaluatePolicy({ raw: result.stdout, exitCode: result.exitCode, policy, lockBytes, manifestBytes, upstream, now: clock(), conditions });
    const bundles = decision.exception ? verifyBundles(bundleDirectories) : [];
    if (decision.exception && currentProfile(policy)) verifyExportEvidence(bundleDirectories, directory, policy);
    requireThat(!decision.exception || clock() < Date.parse(policy.expiresAt), 'Approved exception expired during verification');
    Object.assign(summary, decision, { lockSha256: sha256(lockBytes), auditGraphSha256: auditGraphSha256(report),
      policySha256: sha256(readFileSync(resolve(directory, 'scripts/security-policy.json'))),
      ...(currentProfile(policy) ? { lockGraphSha256: policy.lockGraphSha256, controlsSha256: policy.controlsSha256, conditions } : {}), bundles });
  } catch (error) { summary.error = error instanceof Error ? error.message : String(error); }
  save('policy-result.json', JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

export function securityJobOutputs(result) {
  requireThat(['PASS', 'PASS WITH APPROVED EXCEPTION', 'FAIL'].includes(result.status), 'Invalid security job status');
  const values = { status: result.status, npmAudit: result.npmAudit, policySha256: result.policySha256 ?? '', lockSha256: result.lockSha256 ?? '' };
  requireThat(['PASS', 'FAIL', 'ERROR'].includes(values.npmAudit), 'Invalid raw audit job status');
  for (const name of ['policySha256', 'lockSha256']) requireThat(values[name] === '' || /^[a-f0-9]{64}$/.test(values[name]), 'Invalid job fingerprint');
  return Object.entries(values).map(([name, value]) => name + '=' + value + '\n').join('');
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
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, securityJobOutputs(result));
  process.exitCode = result.status === 'FAIL' ? 1 : 0;
}
