// The gate runs an unfiltered npm audit and accepts only explicitly reviewed
// advisories whose current dependency reachability and controls still match.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { exportEnvironmentSha256, exportInputSha256, verifyToolingConditions } from './security-tooling-conditions.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const semver = createRequire(import.meta.url)('semver');
const levels = ['info', 'low', 'moderate', 'high', 'critical'];
const controls = [
  'unsigned-export-wrapper', 'export-command-allowlist', 'static-config-only', 'reject-signing-inputs',
  'reject-privileged-inputs', 'read-only-pinned-ci', 'fresh-client-source-maps', 'current-build-provenance',
  'reviewed-tooling-call-paths',
];
// Only the installed code on the accepted vulnerable call paths is attested.
// Unrelated dependency changes and application/helper edits remain independent.
export const REVIEWED_TOOLING_SOURCES = Object.freeze({
  '@expo/config/build/Config.js': 'cf6ce6da50cd131b5df308b0658cbfa66958f70a4a94f578b3d65dc8d8c28049',
  'expo/node_modules/@expo/cli/build/src/export/exportApp.js': '347c895b94b8aae6dfd4a253f56d74a494aac95f228a88b66bdca77486f55619',
  'expo/node_modules/@expo/cli/build/src/export/exportAsync.js': 'c347b9ef7dfe79818966c94aea9f6d87b5d2f013bc294d24cb874f3b78278879',
  '@rollup/plugin-node-resolve/dist/cjs/index.js': '98eee3d5a03aac277c01f78be8af18fe19cae7cb0fe79e2b9817af44051a07b9',
  'workbox-build/build/lib/bundle.js': '1a35c5587e400b14695e3b021cbdc9eb90f628ace71b359c772b45d6648c66d6',
});

// This small catalog is a second guard against adding a wildcard or a new
// accepted advisory by editing JSON alone. A new accepted risk needs a code
// review of its package, severity, affected range and reachability assumptions.
// These explicit roots include the installed Expo peer links; they all reach
// the same CLI/config tooling. They do not allow arbitrary new peer consumers.
const EXPO_ROOTS = Object.freeze(['expo', 'expo-constants', 'expo-crypto', 'expo-font', 'expo-linking', 'expo-router',
  'expo-secure-store', 'expo-splash-screen', 'expo-sqlite', 'expo-status-bar', 'expo-system-ui']);
const REVIEWED_RISKS = Object.freeze({
  'GHSA-86w9-cpqp-85rv': Object.freeze({ package: 'node-forge', range: '<= 1.4.0', severity: 'high', npmSource: 1240912,
    status: 'remediated', fixedIn: '1.4.1', roots: EXPO_ROOTS,
    measures: ['unsigned-export-wrapper', 'reject-signing-inputs', 'fresh-client-source-maps', 'current-build-provenance'] }),
  'GHSA-mrhx-c7xc-m3w5': Object.freeze({ package: 'zod', range: '< 4.6.6', severity: 'high', npmSource: 1243066,
    status: 'accepted', fixedIn: '4.6.6', version: '3.25.76', roots: ['eslint-config-expo', ...EXPO_ROOTS],
    measures: ['unsigned-export-wrapper', 'static-config-only', 'fresh-client-source-maps', 'read-only-pinned-ci', 'reject-privileged-inputs', 'current-build-provenance', 'reviewed-tooling-call-paths'] }),
  'GHSA-gcqx-w48m-w2h4': Object.freeze({ package: 'deepmerge', range: '>= 4.2.0 <= 4.3.1', severity: 'low', npmSource: 1243505,
    status: 'accepted', fixedIn: null, version: '4.3.1', roots: [...EXPO_ROOTS, 'workbox-build'],
    measures: ['export-command-allowlist', 'static-config-only', 'fresh-client-source-maps', 'read-only-pinned-ci', 'reject-privileged-inputs', 'current-build-provenance', 'reviewed-tooling-call-paths'] }),
});
export const REVIEWED_RISK_PACKAGES = Object.freeze([...new Set(Object.values(REVIEWED_RISKS).map(row => row.package))]);
export const AUDIT_ARGS = Object.freeze(['audit', '--json', '--registry=https://registry.npmjs.org/',
  '--include=prod', '--include=dev', '--include=optional', '--include=peer', '--audit-level=info', '--workspaces=false']);
export const sha256 = value => createHash('sha256').update(value).digest('hex');

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digestObject = value => sha256(JSON.stringify(canonical(value)));
const normalizedRange = value => value.replace(/[\s,]/g, '');

function parseJson(bytes, label) {
  try { return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes); }
  catch { throw new Error('Invalid ' + label + ' JSON'); }
}

export function validatePackageInputs(lockBytes, manifestBytes) {
  const lock = parseJson(lockBytes, 'package-lock');
  const manifest = parseJson(manifestBytes, 'package manifest');
  requireThat(object(lock) && (lock.lockfileVersion === 2 || lock.lockfileVersion === 3)
    && object(lock.packages) && object(lock.packages['']), 'Unsupported or incomplete package-lock; run npm ci with a valid lockfile');
  requireThat(object(manifest) && typeof manifest.name === 'string' && typeof manifest.version === 'string',
    'Invalid package manifest identity');
  const lockRoot = lock.packages[''];
  requireThat(lockRoot.name === manifest.name && lockRoot.version === manifest.version,
    'package-lock root identity does not match package.json');
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    requireThat(digestObject(lockRoot[section] ?? {}) === digestObject(manifest[section] ?? {}),
      'package-lock root ' + section + ' does not match package.json');
  }
  requireThat(Object.entries(lock.packages).every(([path, row]) => path === '' || (typeof path === 'string' && object(row))),
    'Invalid package-lock package entry');
  return { lock, manifest };
}

function packageNameFromLockPath(path) {
  return path.replace(/^node_modules\//, '').split('/node_modules/').at(-1);
}

export function reviewedAffectedNodes(lock, row) {
  for (const [path, item] of Object.entries(lock.packages)) if (path !== '' && packageNameFromLockPath(path) === row.package)
    requireThat(semver.valid(item.version), 'Invalid reviewed package version in package-lock: ' + path);
  return Object.entries(lock.packages).filter(([path, item]) => path !== ''
      && packageNameFromLockPath(path) === row.package && semver.valid(item.version)
      && semver.satisfies(item.version, row.affectedVersions)).map(([path]) => path).sort();
}

export function verifyAuditCoverage(report, policy, lock) {
  for (const row of policy.riskRegister) {
    const affectedNodes = reviewedAffectedNodes(lock, row);
    const finding = report.vulnerabilities[row.package];
    const reported = finding?.via?.some(via => object(via) && via.url?.split('/').at(-1) === row.id) ?? false;
    if (affectedNodes.length && row.status === 'remediated')
      requireThat(false, 'A remediated advisory matches an affected package in package-lock: ' + row.id);
    if (affectedNodes.length && row.status === 'accepted') {
      requireThat(reported && finding && affectedNodes.every(path => finding.nodes.includes(path)),
        'npm audit omitted a known affected lock node: ' + row.id);
    }
    if (!affectedNodes.length && reported)
      requireThat(false, 'npm audit reported a reviewed advisory without an affected lock node: ' + row.id);
  }
}

export function validateRiskRegister(policy) {
  requireThat(exactKeys(policy, ['policyVersion', 'decision', 'scope', 'riskRegister', 'mandatoryControls'])
    && policy.policyVersion === 2 && policy.decision === 'permanent-reviewed-risk-register'
    && policy.scope === 'isolated-unsigned-static-export', 'Unsupported security risk register');
  requireThat(Array.isArray(policy.riskRegister) && policy.riskRegister.length === Object.keys(REVIEWED_RISKS).length,
    'Security risk register must match the reviewed advisory catalog');
  requireThat(JSON.stringify(policy.mandatoryControls) === JSON.stringify(controls),
    'Mandatory security controls changed; review the gate and policy together');
  const seen = new Set();
  const rowKeys = ['id', 'package', 'affectedVersions', 'severity', 'npmSource', 'status', 'fixedIn', 'installedAtReview',
    'dependencyRoots', 'use', 'reachability', 'attackerControlledInput', 'rationale', 'compensatingMeasures', 'reviewTriggers'];
  for (const row of policy.riskRegister) {
    requireThat(exactKeys(row, rowKeys) && !seen.has(row.id), 'Invalid or duplicate risk-register entry');
    seen.add(row.id);
    const expected = REVIEWED_RISKS[row.id];
    requireThat(expected && row.package === expected.package && row.affectedVersions === expected.range
      && row.severity === expected.severity && row.npmSource === expected.npmSource
      && row.status === expected.status && row.fixedIn === expected.fixedIn,
    'Unreviewed advisory, severity, range or decision: ' + row.id);
    requireThat(strings(row.dependencyRoots) && JSON.stringify([...row.dependencyRoots].sort()) === JSON.stringify(expected.roots),
      'Dependency reachability assumptions changed: ' + row.id);
    requireThat(strings(row.compensatingMeasures)
      && JSON.stringify(row.compensatingMeasures) === JSON.stringify(expected.measures),
    'Compensating measures changed: ' + row.id);
    requireThat(['use', 'reachability', 'attackerControlledInput', 'rationale'].every(key => typeof row[key] === 'string' && row[key].trim())
      && strings(row.reviewTriggers) && row.reviewTriggers.length > 0, 'Incomplete risk assessment: ' + row.id);
    requireThat(semver.valid(row.installedAtReview) && semver.validRange(row.affectedVersions),
      'Invalid reviewed version/range: ' + row.id);
    if (row.status === 'accepted') requireThat(row.installedAtReview === expected.version && semver.satisfies(row.installedAtReview, row.affectedVersions),
      'Accepted risk does not describe an affected package version: ' + row.id);
    else requireThat(!semver.satisfies(row.installedAtReview, row.affectedVersions)
      && semver.valid(row.fixedIn) && semver.gt(row.installedAtReview, row.fixedIn),
    'Remediated risk must record a version outside its affected range: ' + row.id);
  }
  requireThat(Object.keys(REVIEWED_RISKS).every(id => seen.has(id)), 'A reviewed risk record was removed');
  return policy.riskRegister;
}

export function parseAudit(raw, exitCode) {
  const report = parseJson(raw, 'npm audit report');
  requireThat(object(report) && !report.error && report.auditReportVersion === 2 && object(report.vulnerabilities)
    && object(report.metadata?.vulnerabilities), 'Invalid/incomplete npm audit report or registry error');
  requireThat(exactKeys(report, ['auditReportVersion', 'vulnerabilities', 'metadata']), 'Unknown npm audit report structure');
  requireThat(exactKeys(report.metadata.dependencies, ['prod', 'dev', 'optional', 'peer', 'peerOptional', 'total'])
    && Object.values(report.metadata.dependencies).every(value => Number.isSafeInteger(value) && value >= 0)
    && report.metadata.dependencies.total > 0, 'Incomplete npm audit dependency metadata');
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
    && summary.total === total, 'npm audit summary does not match its findings');
  requireThat(exitCode === (total ? 1 : 0), 'npm audit returned an inconsistent exit code');
  return report;
}

function dependencySpecs(row) {
  return { ...(row.peerDependencies ?? {}), ...(row.dependencies ?? {}), ...(row.optionalDependencies ?? {}), ...(row.devDependencies ?? {}) };
}

function resolveLockedDependency(parentPath, dependency, packages) {
  const bases = [];
  let current = parentPath;
  if (!current) bases.push('');
  while (current) {
    bases.push(current);
    const marker = current.lastIndexOf('/node_modules/');
    if (marker >= 0) current = current.slice(0, marker);
    else if (current.startsWith('node_modules/')) current = '';
    else current = '';
    if (current === '' && !bases.includes('')) bases.push('');
  }
  for (const base of bases) {
    const candidate = base ? base + '/node_modules/' + dependency : 'node_modules/' + dependency;
    if (Object.hasOwn(packages, candidate)) return candidate;
  }
  return null;
}

function dependencyGraph(lock) {
  const packages = lock.packages, edges = new Map(Object.keys(packages).map(path => [path, []]));
  for (const [parentPath, parent] of Object.entries(packages)) {
    for (const [name, range] of Object.entries(dependencySpecs(parent))) {
      const childPath = resolveLockedDependency(parentPath, name, packages);
      if (childPath) edges.get(parentPath).push({ childPath, name, range, parentPath });
    }
  }
  return edges;
}

export function dependencyRoots(lock, manifest, targetPath) {
  const graph = dependencyGraph(lock), roots = [];
  const rootDependencies = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}), ...(manifest.optionalDependencies ?? {}) };
  for (const name of Object.keys(rootDependencies)) {
    const start = resolveLockedDependency('', name, lock.packages);
    if (!start) continue;
    const visited = new Set([start]), queue = [start];
    let reached = false;
    while (queue.length) {
      const current = queue.shift();
      if (current === targetPath) { reached = true; break; }
      for (const edge of graph.get(current) ?? []) if (!visited.has(edge.childPath)) {
        visited.add(edge.childPath); queue.push(edge.childPath);
      }
    }
    if (reached) roots.push(name);
  }
  return roots.sort();
}

function consumersForNode(lock, targetPath) {
  const edges = dependencyGraph(lock), result = [];
  for (const row of edges.values()) for (const edge of row) if (edge.childPath === targetPath) result.push(edge);
  return result;
}

function verifyRiskReachability(report, policy, lock, manifest) {
  const riskByPackage = new Map(policy.riskRegister.filter(row => row.status === 'accepted').map(row => [row.package, row]));
  const advisoryIds = new Set();
  for (const finding of Object.values(report.vulnerabilities)) for (const via of finding.via)
    if (object(via) && typeof via.url === 'string') {
      const id = via.url.split('/').at(-1), row = policy.riskRegister.find(candidate => candidate.id === id);
      requireThat(row && row.status === 'accepted', 'Unknown, remediated or unreviewed advisory: ' + id);
      requireThat(finding.name === row.package && via.source === row.npmSource && via.name === row.package
        && via.dependency === row.package && via.severity === row.severity && via.url === 'https://github.com/advisories/' + row.id
        && normalizedRange(via.range) === normalizedRange(row.affectedVersions), 'Advisory scope changed: ' + id);
      const packageFinding = report.vulnerabilities[row.package];
      requireThat(packageFinding && packageFinding.via.some(item => object(item) && item.url === via.url),
        'Advisory root is missing from npm audit: ' + id);
      for (const node of packageFinding.nodes) {
        const locked = lock.packages[node];
        requireThat(locked && typeof locked.version === 'string' && semver.valid(locked.version)
          && semver.satisfies(locked.version, row.affectedVersions), 'Affected audit node does not match package-lock: ' + node);
        requireThat(locked.version === row.installedAtReview, 'Vulnerable package version requires risk reassessment: ' + row.package);
        const roots = dependencyRoots(lock, manifest, node);
        requireThat(roots.length > 0 && roots.every(name => row.dependencyRoots.includes(name)),
          'Vulnerable package gained an unreviewed dependency root: ' + row.package + ' via ' + roots.join(', '));
      }
      advisoryIds.add(id);
    }
  const pending = new Map(Object.keys(report.vulnerabilities).map(name => [name, new Set()]));
  const graph = dependencyGraph(lock);
  for (const [name, finding] of Object.entries(report.vulnerabilities)) {
    requireThat(finding.nodes.every(node => packageNameFromLockPath(node) === name && lock.packages[node]),
      'Audit finding does not identify its locked package: ' + name);
    const fix = finding.fixAvailable;
    if (object(fix) && fix.isSemVerMajor === false) {
      const spec = dependencySpecs(manifest)[fix.name];
      requireThat(!spec || !semver.validRange(spec) || !semver.valid(fix.version) || !semver.satisfies(fix.version, spec),
        'npm audit reports a compatible root dependency fix; update ' + fix.name);
    }
    for (const via of finding.via) {
      if (typeof via === 'string') {
        requireThat(pending.has(via), 'Unresolved npm audit meta finding: ' + via);
        requireThat(finding.nodes.every(node => (graph.get(node) ?? []).some(edge => report.vulnerabilities[via].nodes.includes(edge.childPath))),
          'npm audit via edge does not match the installed dependency graph: ' + name + ' -> ' + via);
      }
      else pending.get(name).add(via.url.split('/').at(-1));
    }
    for (const effect of finding.effects) {
      requireThat(pending.has(effect), 'Unknown npm audit effects edge: ' + name + ' -> ' + effect);
      const target = report.vulnerabilities[effect];
      requireThat(target.via.some(via => typeof via === 'string' && via === name),
        'npm audit effects edge is unsupported by its via graph: ' + name + ' -> ' + effect);
    }
  }
  let changed;
  do {
    changed = false;
    for (const [name, finding] of Object.entries(report.vulnerabilities)) for (const via of finding.via) {
      if (typeof via !== 'string') continue;
      for (const id of pending.get(via)) if (!pending.get(name).has(id)) { pending.get(name).add(id); changed = true; }
    }
  } while (changed);
  requireThat([...pending.values()].every(ids => ids.size > 0), 'Audit graph contains an unanchored or unknown advisory path');
  for (const [name, ids] of pending) {
    const reviewedSeverity = Math.max(...[...ids].map(id => levels.indexOf(REVIEWED_RISKS[id].severity)));
    requireThat(levels.indexOf(report.vulnerabilities[name].severity) === reviewedSeverity,
      'npm audit package severity does not match its reviewed advisory graph: ' + name);
  }
  requireThat(advisoryIds.size > 0 && [...advisoryIds].every(id => riskByPackage.has(REVIEWED_RISKS[id].package)),
    'Audit findings are not covered by an accepted risk record');
  return [...advisoryIds].sort();
}

export function verifyInstalledPackages(report, lock, directory = root) {
  for (const finding of Object.values(report.vulnerabilities)) for (const node of finding.nodes) {
    requireThat(/^node_modules\/(?!.*(?:^|\/)\.\.(?:\/|$))/.test(node), 'Unsafe installed package path from npm audit');
    const locked = lock.packages[node];
    requireThat(locked && typeof locked.version === 'string', 'Audit package node is missing from lockfile: ' + node);
    let path = resolve(directory, node);
    const relativePath = path.slice(resolve(directory).length + 1).split(/[\\/]/);
    let cursor = resolve(directory);
    for (const segment of relativePath) {
      cursor = resolve(cursor, segment);
      requireThat(existsSync(cursor) && !lstatSync(cursor).isSymbolicLink(), 'Missing or symlinked installed audit node: ' + node);
    }
    const installed = parseJson(readFileSync(resolve(path, 'package.json')), 'installed package');
    const expectedName = node.replace(/^node_modules\//, '').split('/node_modules/').at(-1);
    requireThat(installed.name === expectedName && installed.version === locked.version,
      'Installed package does not match package-lock: ' + node);
  }
  // npm audit uses the lockfile. Also inspect the actual module tree so a
  // stale hidden lock cannot conceal a second vulnerable installation/alias.
  const installedRiskNodes = new Set();
  const walk = (modules, prefix = 'node_modules', scoped = false) => {
    if (!existsSync(modules)) return;
    requireThat(!lstatSync(modules).isSymbolicLink(), 'Symlinked installed dependency directory');
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const folder = resolve(modules, entry.name), node = prefix + '/' + entry.name;
      requireThat(!entry.isSymbolicLink(), 'Symlinked installed dependency: ' + node);
      if (!entry.isDirectory()) continue;
      if (!scoped && entry.name.startsWith('@')) { walk(folder, node, true); continue; }
      const manifest = resolve(folder, 'package.json');
      if (existsSync(manifest)) {
        const installed = parseJson(readFileSync(manifest), 'installed package');
        if (REVIEWED_RISK_PACKAGES.includes(installed.name)) {
          const locked = lock.packages[node];
          requireThat(locked && installed.name === packageNameFromLockPath(node) && installed.version === locked.version,
            'Unrecorded installed reviewed-risk package or version: ' + node);
          installedRiskNodes.add(node);
        }
      }
      walk(resolve(folder, 'node_modules'), node + '/node_modules');
    }
  };
  walk(resolve(directory, 'node_modules'));
  for (const path of Object.keys(lock.packages)) if (REVIEWED_RISK_PACKAGES.includes(packageNameFromLockPath(path)))
    requireThat(installedRiskNodes.has(path), 'Missing installed reviewed-risk package: ' + path);
}

export function verifyToolingRiskConditions(policy, conditions) {
  validateRiskRegister(policy);
  const expected = {
    scope: 'isolated-unsigned-static-export', unsignedExportOnly: true, signingInputsRejected: true,
    dynamicConfigRejected: true, credentialInputsAbsent: true, ciPermissionsReadOnly: true,
    actionsPinned: true, untrustedWorkflowInputsRejected: true, dotenvDisabled: true, releaseJobsMandatory: true,
  };
  requireThat(Object.entries(expected).every(([key, value]) => conditions?.[key] === value),
    'A required unsigned-export, credential, workflow or release control is not satisfied');
}

export function verifyReviewedToolingSources(directory = root) {
  return Object.entries(REVIEWED_TOOLING_SOURCES).map(([file, expected]) => {
    let cursor = resolve(directory, 'node_modules');
    for (const segment of file.split('/')) {
      cursor = resolve(cursor, segment);
      requireThat(existsSync(cursor) && !lstatSync(cursor).isSymbolicLink(), 'Missing or symlinked reviewed tooling source: ' + file);
    }
    const actual = sha256(readFileSync(cursor));
    requireThat(actual === expected, 'Installed vulnerable tooling call path changed; risk reassessment required: ' + file);
    return { file, sha256: actual };
  });
}

export function verifyUpstream(policy, upstream, report, lock) {
  const accepted = policy.riskRegister.filter(row => row.status === 'accepted'
    && report.vulnerabilities[row.package]?.via.some(via => object(via) && via.url?.split('/').at(-1) === row.id));
  for (const row of accepted) {
    const entry = upstream?.[row.id], advisory = entry?.advisory, registry = entry?.registry;
    requireThat(advisory?.ghsa_id === row.id && advisory.type === 'reviewed' && advisory.withdrawn_at === null
      && advisory.severity === row.severity && Array.isArray(advisory.vulnerabilities) && advisory.vulnerabilities.length === 1,
    'Official advisory changed or is unavailable: ' + row.id);
    const vulnerability = advisory.vulnerabilities[0];
    requireThat(vulnerability.package?.ecosystem === 'npm' && vulnerability.package.name === row.package
      && normalizedRange(vulnerability.vulnerable_version_range) === normalizedRange(row.affectedVersions)
      && vulnerability.first_patched_version === row.fixedIn, 'Official advisory scope or patch status changed: ' + row.id);
    requireThat(registry?.name === row.package && object(registry.versions)
      && typeof registry['dist-tags']?.latest === 'string' && semver.valid(registry['dist-tags'].latest),
    'Official npm package metadata is unavailable: ' + row.package);
    const latest = registry['dist-tags'].latest;
    requireThat(registry.versions[latest]?.name === row.package && registry.versions[latest]?.version === latest,
      'Official latest package record is incomplete: ' + row.package);
    if (row.fixedIn) requireThat(registry.versions[row.fixedIn]?.name === row.package
      && registry.versions[row.fixedIn]?.version === row.fixedIn, 'Official fixed version is missing from npm: ' + row.package);
    else requireThat(semver.satisfies(latest, row.affectedVersions),
      'A newer release may address the advisory; reassess before accepting ' + row.id);

    const candidate = row.fixedIn ?? (!semver.satisfies(latest, row.affectedVersions) ? latest : null);
    if (candidate && report.vulnerabilities[row.package]) {
      const nodes = report.vulnerabilities[row.package].nodes;
      const allNodesHaveCompatiblePath = nodes.every(node => {
        const consumers = consumersForNode(lock, node);
        requireThat(consumers.length > 0, 'Cannot identify the consumers of vulnerable ' + row.package);
        return consumers.every(edge => typeof edge.range === 'string' && semver.validRange(edge.range)
          && semver.satisfies(candidate, edge.range));
      });
      requireThat(!allNodesHaveCompatiblePath,
        'A fixed release satisfies every current consumer range; update ' + row.package + ' before accepting the risk');
    }
  }
}

export function evaluatePolicy({ raw, exitCode, policy, lockBytes, manifestBytes, upstream, conditions }) {
  const report = parseAudit(raw, exitCode);
  const risks = validateRiskRegister(policy);
  const { lock, manifest } = validatePackageInputs(lockBytes, manifestBytes);
  verifyAuditCoverage(report, policy, lock);
  verifyToolingRiskConditions(policy, conditions);
  if (report.metadata.vulnerabilities.total === 0)
    return { status: 'PASS', npmAudit: 'PASS', counts: report.metadata.vulnerabilities, acceptedRiskIds: [] };
  const acceptedRiskIds = verifyRiskReachability(report, policy, lock, manifest);
  verifyUpstream(policy, upstream, report, lock);
  requireThat(acceptedRiskIds.every(id => risks.some(row => row.id === id && row.status === 'accepted')),
    'An active advisory is not accepted');
  return { status: 'PASS WITH ACCEPTED RISKS', npmAudit: 'FAIL', counts: report.metadata.vulnerabilities, acceptedRiskIds };
}

export function verifyBundles(directories, packageNames = REVIEWED_RISK_PACKAGES) {
  requireThat(Array.isArray(directories) && directories.length > 0, 'Fresh Web/Android/iOS bundle evidence is required');
  const pattern = new RegExp('(^|[\\/])(?:' + packageNames.map(name => name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')).join('|') + ')([\\/]|$)');
  const maps = [];
  const walk = directory => {
    requireThat(existsSync(directory) && !lstatSync(directory).isSymbolicLink(), 'Missing or symlinked bundle evidence directory');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      requireThat(!entry.isSymbolicLink(), 'Symlink in build evidence');
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.map')) {
        const platform = path.replace(/\\/g, '/').match(/\/_expo\/static\/js\/(web|android|ios)\//)?.[1];
        if (!platform) continue;
        const bytes = readFileSync(path), data = parseJson(bytes, 'source map');
        requireThat(data.version === 3 && strings(data.sources) && data.sources.length > 0
          && existsSync(path.slice(0, -4)), 'Incomplete current bundle/source-map evidence: ' + path);
        requireThat(data.sourceRoot === undefined || typeof data.sourceRoot === 'string', 'Invalid source-map sourceRoot');
        requireThat(!data.sources.some(source => pattern.test(decodeURI((data.sourceRoot ?? '') + '/' + source))),
          'A reviewed-risk package is present in the ' + platform + ' client bundle');
        maps.push({ platform, map: path, sources: data.sources.length, mapSha256: sha256(bytes),
          bundleSha256: sha256(readFileSync(path.slice(0, -4))) });
      }
    }
  };
  for (const directory of directories) walk(resolve(directory));
  requireThat(['web', 'android', 'ios'].every(platform => maps.some(row => row.platform === platform)),
    'Fresh Web/Android/iOS source-map proof is incomplete');
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

export async function fetchUpstream(risks, fetchImpl = fetch, capture = () => undefined) {
  const rows = Array.isArray(risks) ? risks : risks.riskRegister.filter(row => row.status === 'accepted');
  const upstream = Object.fromEntries(rows.map(row => [row.id, {}]));
  const requests = rows.flatMap(row => [
    { row, kind: 'advisory', url: 'https://api.github.com/advisories/' + row.id },
    { row, kind: 'registry', url: 'https://registry.npmjs.org/' + encodeURIComponent(row.package) },
  ]);
  const results = await Promise.allSettled(requests.map(async ({ row, kind, url }) => {
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: {
      Accept: kind === 'advisory' ? 'application/vnd.github+json' : 'application/json', 'User-Agent': 'TaskTrace-security-policy',
    } });
    requireThat(response.ok, 'Official security metadata unavailable: HTTP ' + response.status + ' ' + url);
    const raw = await response.text();
    capture(row.package.replaceAll('/', '-') + '-' + kind + '.json', raw);
    upstream[row.id][kind] = parseJson(raw, 'official ' + kind + ' metadata');
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return upstream;
}

export function verifyExportEvidence(directories, directory, lockBytes, manifestBytes, maps, environment = {}) {
  const inputs = exportInputSha256(directory);
  const lockHash = sha256(lockBytes), manifestHash = sha256(manifestBytes);
  for (const folder of directories) {
    const metadata = parseJson(readFileSync(resolve(folder, 'security-export.json')), 'security export evidence');
    requireThat(metadata.environmentSha256 === exportEnvironmentSha256(environment), 'Build configuration does not match the current export environment');
    requireThat(metadata.kind === 'isolated-unsigned-static-export' && metadata.inputNormalization === 'runtime-export-inputs-lf-v1'
      && metadata.inputsSha256 === inputs && metadata.lockSha256 === lockHash && metadata.packageManifestSha256 === manifestHash,
    'Build provenance does not match the current source, manifest and lockfile');
    requireThat(Array.isArray(metadata.files) && metadata.files.length > 0, 'Missing current export artifact hashes');
    const known = new Set();
    for (const row of metadata.files) {
      requireThat(typeof row.file === 'string' && /^_expo\/static\/js\/(?:web|android|ios)\/[a-zA-Z0-9_./-]+$/.test(row.file)
        && !row.file.split('/').includes('..') && !known.has(row.file), 'Invalid or duplicate export artifact path');
      known.add(row.file);
      requireThat(sha256(readFileSync(resolve(folder, row.file))) === row.sha256, 'Current export artifact hash changed: ' + row.file);
    }
    const folderPrefix = resolve(folder) + (process.platform === 'win32' ? '\\' : '/');
    for (const row of maps.filter(item => item.map.startsWith(folderPrefix))) {
      const map = row.map.slice(folderPrefix.length).replaceAll('\\', '/');
      requireThat(known.has(map) && known.has(map.slice(0, -4)), 'Unrecorded current client bundle or source map');
    }
  }
}

export async function runGate({ directory = root, output = resolve(directory, '.expo/security-policy'), bundleDirectories = [],
  audit = runNpmAudit, fetchImpl = fetch, clock = Date.now, environment = process.env,
  revision = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8', windowsHide: true }).trim() } = {}) {
  mkdirSync(output, { recursive: true });
  const summary = { status: 'FAIL', npmAudit: 'ERROR', generatedAt: new Date(clock()).toISOString(), auditArgs: AUDIT_ARGS };
  const save = (name, raw) => writeFileSync(resolve(output, name), raw);
  try {
    const result = await audit(directory);
    save('npm-audit.json', result.stdout || '');
    save('npm-audit.stderr.log', result.stderr || '');
    summary.npmExitCode = result.exitCode;
    requireThat(!result.error, 'npm audit execution failed: ' + result.error);
    const report = parseAudit(result.stdout, result.exitCode);
    summary.npmAudit = report.metadata.vulnerabilities.total ? 'FAIL' : 'PASS';
    summary.counts = report.metadata.vulnerabilities;
    const policyBytes = readFileSync(resolve(directory, 'scripts/security-policy.json'));
    const policy = parseJson(policyBytes, 'security policy');
    const lockBytes = readFileSync(resolve(directory, 'package-lock.json'));
    const manifestBytes = readFileSync(resolve(directory, 'package.json'));
    const { lock, manifest } = validatePackageInputs(lockBytes, manifestBytes);
    validateRiskRegister(policy);
    verifyAuditCoverage(report, policy, lock);
    const conditions = verifyToolingConditions({ directory, environment });
    verifyToolingRiskConditions(policy, conditions);
    const activeIds = report.metadata.vulnerabilities.total ? verifyRiskReachability(report, policy, lock, manifest) : [];
    verifyInstalledPackages(report, lock, directory);
    const toolingSources = activeIds.length ? verifyReviewedToolingSources(directory) : [];
    const activeRows = policy.riskRegister.filter(row => activeIds.includes(row.id));
    const upstream = activeRows.length ? await fetchUpstream(activeRows, fetchImpl, save) : {};
    const decision = evaluatePolicy({ raw: result.stdout, exitCode: result.exitCode, policy, lockBytes, manifestBytes, upstream, conditions });
    const maps = verifyBundles(bundleDirectories, policy.riskRegister.map(row => row.package));
    verifyExportEvidence(bundleDirectories, directory, lockBytes, manifestBytes, maps, environment);
    const commit = revision();
    requireThat(/^[a-f0-9]{40}$/.test(commit), 'Security verification requires the actual checkout SHA');
    if (environment.GITHUB_ACTIONS === 'true') requireThat(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'],
      { cwd: directory, encoding: 'utf8', windowsHide: true }).trim() === '', 'CI security checkout has tracked modifications');
    Object.assign(summary, decision, {
      commit,
      lockSha256: sha256(lockBytes), manifestSha256: sha256(manifestBytes),
      policySha256: sha256(policyBytes), exportInputsSha256: exportInputSha256(directory), exportEnvironmentSha256: exportEnvironmentSha256(environment),
      conditions, toolingSources, bundles: maps,
    });
  } catch (error) { summary.error = error instanceof Error ? error.message : String(error); }
  save('policy-result.json', JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

export function securityJobOutputs(result) {
  requireThat(['PASS', 'PASS WITH ACCEPTED RISKS', 'FAIL'].includes(result.status), 'Invalid security job status');
  const values = {
    status: result.status,
    commit: result.commit ?? '',
    npmAudit: result.npmAudit,
    policySha256: result.policySha256 ?? '',
    lockSha256: result.lockSha256 ?? '',
    manifestSha256: result.manifestSha256 ?? '',
    acceptedRiskIds: JSON.stringify(result.acceptedRiskIds ?? []),
  };
  requireThat(['PASS', 'FAIL', 'ERROR'].includes(values.npmAudit), 'Invalid raw npm audit status');
  requireThat(values.commit === '' && result.status === 'FAIL' || /^[a-f0-9]{40}$/.test(values.commit), 'Invalid security checkout SHA');
  for (const name of ['policySha256', 'lockSha256', 'manifestSha256'])
    requireThat(values[name] === '' || /^[a-f0-9]{64}$/.test(values[name]), 'Invalid current input fingerprint');
  return Object.entries(values).map(([name, value]) => name + '=' + value + '\n').join('');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directories = [];
  for (let index = 2; index < process.argv.length; index += 2) {
    requireThat(process.argv[index] === '--bundles' && process.argv[index + 1],
      'Usage: node scripts/security-policy-gate.mjs --bundles <export-directory> [--bundles <export-directory>]');
    directories.push(process.argv[index + 1]);
  }
  const result = await runGate({ bundleDirectories: directories });
  console.log('npm audit: ' + result.npmAudit + ' (raw report: .expo/security-policy/npm-audit.json)');
  console.log('Security policy gate: ' + result.status);
  if (result.error) console.error(result.error);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, securityJobOutputs(result));
  process.exitCode = result.status === 'FAIL' ? 1 : 0;
}
