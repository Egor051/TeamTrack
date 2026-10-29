import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AUDIT_ARGS, REVIEWED_TOOLING_SOURCES, dependencyRoots, evaluatePolicy, fetchUpstream, parseAudit, runGate, sha256, verifyBundles,
  verifyExportEvidence, verifyInstalledPackages, verifyReviewedToolingSources, validatePackageInputs } from '../scripts/security-policy-gate.mjs';
import { CONTROL_FILES, exportEnvironmentSha256, exportInputSha256, verifyToolingConditions } from '../scripts/security-tooling-conditions.mjs';
import { exportArguments, runExport } from '../scripts/security-export.mjs';
import { verifySecurityAcceptance } from '../scripts/release-decision.mjs';

const root = resolve(import.meta.dirname, '..');
const policy = JSON.parse(readFileSync(join(root, 'scripts/security-policy.json'), 'utf8'));
const lockBytes = readFileSync(join(root, 'package-lock.json'));
const manifestBytes = readFileSync(join(root, 'package.json'));
const lock = JSON.parse(lockBytes);
const manifest = JSON.parse(manifestBytes);
const rawAudit = readFileSync(join(root, 'tests/fixtures/security-risk-audit.json'), 'utf8');
const conditions = {
  scope: 'isolated-unsigned-static-export', unsignedExportOnly: true, signingInputsRejected: true,
  dynamicConfigRejected: true, credentialInputsAbsent: true, ciPermissionsReadOnly: true,
  actionsPinned: true, untrustedWorkflowInputsRejected: true, dotenvDisabled: true, releaseJobsMandatory: true,
};
const acceptedRows = policy.riskRegister.filter(row => row.status === 'accepted');
const temporaryDirectories = new Set();

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

function temporaryDirectory(name = 'tasktrace-security-') {
  const directory = mkdtempSync(join(tmpdir(), name));
  temporaryDirectories.add(directory);
  return directory;
}

function cloneProject() {
  const directory = temporaryDirectory();
  for (const file of new Set([...CONTROL_FILES, 'scripts/security-policy.json', 'package-lock.json', 'tsconfig.json',
    'supabase/functions/_shared/client-error-schema.ts'])) {
    const source = join(root, file), target = join(directory, file);
    if (!existsSync(source)) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  return directory;
}

function makeAudit(change = () => {}) {
  const report = JSON.parse(rawAudit);
  change(report);
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const finding of Object.values(report.vulnerabilities)) {
    counts[finding.severity]++;
    counts.total++;
  }
  report.metadata.vulnerabilities = counts;
  return JSON.stringify(report);
}

function cleanAudit() {
  const report = JSON.parse(rawAudit);
  report.vulnerabilities = {};
  report.metadata.vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  return JSON.stringify(report);
}

function registry(name, versions, latest) {
  return { name, 'dist-tags': { latest }, versions: Object.fromEntries(versions.map(version => [version, { name, version }])) };
}

function fakeUpstream(rows = acceptedRows) {
  return Object.fromEntries(rows.map(row => {
    const versions = row.package === 'zod' ? ['3.25.76', '4.6.6', '4.6.7'] : ['4.3.1'];
    const latest = versions.at(-1);
    return [row.id, {
      advisory: {
        ghsa_id: row.id, type: 'reviewed', withdrawn_at: null, severity: row.severity,
        vulnerabilities: [{ package: { ecosystem: 'npm', name: row.package },
          vulnerable_version_range: row.affectedVersions, first_patched_version: row.fixedIn }],
      },
      registry: registry(row.package, versions, latest),
    }];
  }));
}

function evaluate(overrides = {}) {
  return evaluatePolicy({ raw: rawAudit, exitCode: 1, policy: structuredClone(policy), lockBytes, manifestBytes,
    upstream: fakeUpstream(), conditions, ...overrides });
}

function installAuditPackages(directory, report = JSON.parse(rawAudit)) {
  const nodes = new Set([...Object.values(report.vulnerabilities).flatMap(finding => finding.nodes),
    ...Object.keys(lock.packages).filter(node => /(?:^|\/)(?:zod|deepmerge|node-forge)$/.test(node))]);
  for (const node of nodes) {
    const expected = lock.packages[node];
    if (!expected) throw new Error('Fixture audit node missing from current lock: ' + node);
    const packageName = node.replace(/^node_modules\//, '').split('/node_modules/').at(-1);
    const folder = join(directory, node);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: packageName, version: expected.version }));
  }
  for (const file of Object.keys(REVIEWED_TOOLING_SOURCES)) {
    const destination = join(directory, 'node_modules', file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(root, 'node_modules', file), destination);
  }
}

function makeBundles(directory, projectDirectory, { sources = {}, lockfile = lockBytes, packageManifest = manifestBytes } = {}) {
  const files = [];
  for (const platform of ['web', 'android', 'ios']) {
    const relativeBundle = `_expo/static/js/${platform}/entry.js`;
    const bundle = join(directory, relativeBundle);
    mkdirSync(dirname(bundle), { recursive: true });
    writeFileSync(bundle, `synthetic ${platform} bundle`);
    writeFileSync(bundle + '.map', JSON.stringify({ version: 3, sources: sources[platform] ?? ['src/index.tsx'] }));
    for (const file of [relativeBundle, relativeBundle + '.map'])
      files.push({ file, sha256: sha256(readFileSync(join(directory, file))) });
  }
  writeFileSync(join(directory, 'security-export.json'), JSON.stringify({
    kind: 'isolated-unsigned-static-export', inputNormalization: 'runtime-export-inputs-lf-v1',
    lockSha256: sha256(lockfile), packageManifestSha256: sha256(packageManifest),
    inputsSha256: exportInputSha256(projectDirectory), environmentSha256: exportEnvironmentSha256({}), files,
  }));
}

describe('permanent reviewed-risk gate', () => {
  it.each(['id', 'range', 'severity', 'version', 'root', 'measure', 'removed'])('rejects a policy-only alteration of reviewed risk scope: %s', change => {
    const altered = structuredClone(policy), row = altered.riskRegister.find(row => row.package === 'zod');
    if (change === 'id') row.id = '*';
    if (change === 'range') row.affectedVersions = '*';
    if (change === 'severity') row.severity = 'critical';
    if (change === 'version') row.installedAtReview = '4.0.0';
    if (change === 'root') row.dependencyRoots.push('*');
    if (change === 'measure') row.compensatingMeasures.pop();
    if (change === 'removed') altered.riskRegister.pop();
    expect(() => evaluate({ policy: altered })).toThrow();
  });

  it('fails closed when official advisory or registry metadata cannot be fetched', async () => {
    await expect(fetchUpstream(acceptedRows, async () => new Response('unavailable', { status: 503 }))).rejects.toThrow(/HTTP 503/);
    await expect(fetchUpstream(acceptedRows, async () => new Response('{'))).rejects.toThrow(/Invalid official/);
  });
  it('retains the authentic npm audit FAIL while accepting only the active reviewed advisories', () => {
    expect(AUDIT_ARGS).toEqual(['audit', '--json', '--registry=https://registry.npmjs.org/',
      '--include=prod', '--include=dev', '--include=optional', '--include=peer', '--audit-level=info', '--workspaces=false']);
    expect(evaluate()).toMatchObject({
      status: 'PASS WITH ACCEPTED RISKS', npmAudit: 'FAIL',
      acceptedRiskIds: ['GHSA-gcqx-w48m-w2h4', 'GHSA-mrhx-c7xc-m3w5'],
      counts: { high: 3, low: 7, total: 10 },
    });
    expect(JSON.parse(rawAudit).metadata.vulnerabilities).toMatchObject({ high: 3, low: 7, total: 10 });
  });

  it('has no time-based policy fields or decision path, including after the former expiry and years later', () => {
    const forbidden = /^(?:startsAt|expiresAt|durationDays|renewal|earlyTermination|exceptionProfile)$/i;
    expect(Object.keys(policy).some(key => forbidden.test(key))).toBe(false);
    for (const row of policy.riskRegister) expect(Object.keys(row).some(key => forbidden.test(key))).toBe(false);
    for (const time of ['2026-11-08T10:32:09.000Z', '2026-11-09T00:00:00.000Z', '2035-01-01T00:00:00.000Z'])
      expect(evaluate({ now: Date.parse(time) }).status).toBe('PASS WITH ACCEPTED RISKS');
  });

  it('returns clean PASS when an update removes every active finding and does not falsify the report', () => {
    expect(() => evaluate({ raw: cleanAudit(), exitCode: 0, upstream: {} }))
      .toThrow(/npm audit omitted a known affected lock node/);
    const cleanManifest = Buffer.from(JSON.stringify({ name: 'empty-project', version: '1.0.0' }));
    const cleanLock = Buffer.from(JSON.stringify({ lockfileVersion: 3,
      packages: { '': { name: 'empty-project', version: '1.0.0' } } }));
    expect(evaluate({ raw: cleanAudit(), exitCode: 0, upstream: {}, lockBytes: cleanLock, manifestBytes: cleanManifest })).toMatchObject({
      status: 'PASS', npmAudit: 'PASS', acceptedRiskIds: [], counts: { total: 0 },
    });
    expect(policy.riskRegister.find(row => row.package === 'node-forge')).toMatchObject({ status: 'remediated', installedAtReview: '1.4.2' });
    expect(JSON.parse(rawAudit).vulnerabilities['node-forge']).toBeUndefined();
  });

  it('allows a harmless lock tree patch and derives roots from the current graph rather than an old lock hash', () => {
    const updated = structuredClone(lock);
    const safePackage = Object.keys(updated.packages).find(path => path === 'node_modules/semver');
    expect(safePackage).toBeTruthy();
    updated.packages[safePackage].version = '7.6.3';
    expect(evaluate({ lockBytes: Buffer.from(JSON.stringify(updated)) }).status).toBe('PASS WITH ACCEPTED RISKS');
    expect(dependencyRoots(lock, manifest, 'node_modules/zod')).toEqual(['eslint-config-expo', 'expo', 'expo-constants',
      'expo-crypto', 'expo-font', 'expo-linking', 'expo-router', 'expo-secure-store', 'expo-splash-screen', 'expo-sqlite',
      'expo-status-bar', 'expo-system-ui']);
  });

  it('requires reassessment for a different still-vulnerable package version', () => {
    const updated = structuredClone(lock);
    updated.packages['node_modules/zod'].version = '3.25.77';
    expect(() => evaluate({ lockBytes: Buffer.from(JSON.stringify(updated)) })).toThrow(/version requires risk reassessment/);
  });

  it('blocks a newly introduced root path to a reviewed vulnerable package', () => {
    const updatedLock = structuredClone(lock), updatedManifest = structuredClone(manifest);
    updatedManifest.dependencies.deepmerge = '^4.3.1';
    updatedLock.packages[''].dependencies = { ...updatedLock.packages[''].dependencies, deepmerge: '^4.3.1' };
    expect(() => evaluate({ lockBytes: Buffer.from(JSON.stringify(updatedLock)), manifestBytes: Buffer.from(JSON.stringify(updatedManifest)) }))
      .toThrow(/unreviewed dependency root/);
  });

  it('includes installed peer dependency edges when enforcing reviewed roots', () => {
    const updatedLock = structuredClone(lock), updatedManifest = structuredClone(manifest);
    updatedManifest.devDependencies['peer-tool'] = '1.0.0';
    updatedLock.packages[''].devDependencies['peer-tool'] = '1.0.0';
    updatedLock.packages['node_modules/peer-tool'] = { version: '1.0.0', peerDependencies: { zod: '^3.25.0' } };
    expect(() => evaluate({ lockBytes: Buffer.from(JSON.stringify(updatedLock)), manifestBytes: Buffer.from(JSON.stringify(updatedManifest)) }))
      .toThrow(/unreviewed dependency root/);
  });

  it('rejects an escalated package severity even if the advisory object was not updated', () => {
    const raw = makeAudit(report => { report.vulnerabilities.expo.severity = 'critical'; });
    expect(() => evaluate({ raw })).toThrow(/severity/);
  });

  it('checks upstream only for active advisories after a partial remediation', () => {
    const partialManifest = Buffer.from(JSON.stringify({ name: 'partial-remediation', version: '1.0.0', devDependencies: { 'workbox-build': '7.4.1' } }));
    const partialLock = Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: {
      '': JSON.parse(partialManifest),
      'node_modules/workbox-build': { version: '7.4.1', dependencies: { deepmerge: '^4.3.1' } },
      'node_modules/deepmerge': { version: '4.3.1' },
    } }));
    const raw = makeAudit(report => {
      const finding = report.vulnerabilities.deepmerge;
      finding.effects = [];
      report.vulnerabilities = { deepmerge: finding };
    });
    expect(evaluate({ raw, lockBytes: partialLock, manifestBytes: partialManifest,
      upstream: fakeUpstream(acceptedRows.filter(row => row.package === 'deepmerge')) }))
      .toMatchObject({ status: 'PASS WITH ACCEPTED RISKS', acceptedRiskIds: ['GHSA-gcqx-w48m-w2h4'] });
  });

  it.each(['high', 'moderate', 'low', 'critical', 'info'])('blocks a new %s advisory even when its severity is low or informational', severity => {
    const extra = makeAudit(report => {
      const row = structuredClone(report.vulnerabilities.zod);
      row.name = 'new-package'; row.severity = severity; row.nodes = ['node_modules/new-package']; row.effects = [];
      row.via = [{ ...row.via[0], name: row.name, dependency: row.name, severity, url: 'https://github.com/advisories/GHSA-new1-new2-new3' }];
      report.vulnerabilities[row.name] = row;
    });
    expect(() => evaluate({ raw: extra })).toThrow(/Unknown, remediated or unreviewed advisory/);
  });

  it('blocks changed advisory severity, affected range, source identity and official metadata', () => {
    const severity = makeAudit(report => {
      report.vulnerabilities.zod.severity = 'critical';
      report.vulnerabilities.zod.via.find(via => typeof via === 'object').severity = 'critical';
    });
    expect(() => evaluate({ raw: severity })).toThrow(/Advisory scope changed/);
    for (const key of ['source', 'range']) {
      const altered = makeAudit(report => {
        const via = report.vulnerabilities.zod.via.find(item => typeof item === 'object');
        via[key] = key === 'source' ? via.source + 1 : '*';
      });
      expect(() => evaluate({ raw: altered })).toThrow(/Advisory scope changed/);
    }
    const upstream = fakeUpstream();
    upstream['GHSA-mrhx-c7xc-m3w5'].advisory.severity = 'critical';
    expect(() => evaluate({ upstream })).toThrow(/Official advisory changed/);
    const changedPatch = fakeUpstream();
    changedPatch['GHSA-mrhx-c7xc-m3w5'].advisory.vulnerabilities[0].first_patched_version = '4.6.7';
    expect(() => evaluate({ upstream: changedPatch })).toThrow(/Official advisory scope or patch status changed/);
    const missingFixedRelease = fakeUpstream();
    delete missingFixedRelease['GHSA-mrhx-c7xc-m3w5'].registry.versions['4.6.6'];
    expect(() => evaluate({ upstream: missingFixedRelease })).toThrow(/Official fixed version is missing/);
  });

  it('requires reassessment when a compatible fixed release becomes available', () => {
    expect(() => evaluate({ raw: makeAudit(report => {
      report.vulnerabilities.expo.fixAvailable = { name: 'expo', version: '57.0.32', isSemVerMajor: false };
    }) })).toThrow(/compatible root dependency fix/);
    const compatibleZod = structuredClone(lock);
    let consumers = 0;
    for (const entry of Object.values(compatibleZod.packages)) {
      for (const field of ['dependencies', 'optionalDependencies', 'devDependencies']) {
        if (entry[field]?.zod) { entry[field].zod = '^4.6.6'; consumers++; }
      }
    }
    expect(consumers).toBeGreaterThan(0);
    expect(() => evaluate({ lockBytes: Buffer.from(JSON.stringify(compatibleZod)) }))
      .toThrow(/A fixed release satisfies every current consumer range/);

    const patchedDeepmerge = fakeUpstream();
    const packageRegistry = patchedDeepmerge['GHSA-gcqx-w48m-w2h4'].registry;
    packageRegistry.versions['4.4.0'] = { name: 'deepmerge', version: '4.4.0' };
    packageRegistry['dist-tags'].latest = '4.4.0';
    expect(() => evaluate({ upstream: patchedDeepmerge })).toThrow(/A newer release may address the advisory; reassess/);
  });

  it('rejects malformed, incomplete, inconsistent and tampered npm audit reports', () => {
    for (const raw of ['', '{', 'null', '{}', '{"error":{"code":"EAI_AGAIN"}}'])
      expect(() => parseAudit(raw, 1)).toThrow();
    const wrongCounts = JSON.parse(rawAudit);
    wrongCounts.metadata.vulnerabilities.total++;
    expect(() => parseAudit(JSON.stringify(wrongCounts), 1)).toThrow(/summary does not match/);
    expect(() => parseAudit(rawAudit, 0)).toThrow(/inconsistent exit code/);
    const unknownKey = JSON.parse(rawAudit); unknownKey.ignored = true;
    expect(() => parseAudit(JSON.stringify(unknownKey), 1)).toThrow(/Unknown npm audit report structure/);
  });

  it('rejects malformed lockfiles, package identity drift and mismatched manifest declarations', () => {
    const invalidVersion = structuredClone(lock); invalidVersion.packages['node_modules/zod'].version = 'invalid';
    expect(() => evaluate({ raw: cleanAudit(), exitCode: 0, lockBytes: Buffer.from(JSON.stringify(invalidVersion)) }))
      .toThrow(/Invalid reviewed package version/);
    for (const bytes of [Buffer.from('{'), Buffer.from('{}')])
      expect(() => validatePackageInputs(bytes, manifestBytes)).toThrow();
    const badLock = structuredClone(lock); badLock.packages[''].dependencies.react = '^19.1.0';
    expect(() => validatePackageInputs(Buffer.from(JSON.stringify(badLock)), manifestBytes)).toThrow(/does not match package.json/);
    const badManifest = structuredClone(manifest); badManifest.name += '-other';
    expect(() => validatePackageInputs(lockBytes, Buffer.from(JSON.stringify(badManifest)))).toThrow(/identity/);
  });

  it('fails closed for missing audit graph edges and unknown dependency paths', () => {
    const unrelated = makeAudit(report => { report.vulnerabilities.expo.via.push('workbox-build'); });
    expect(() => evaluate({ raw: unrelated })).toThrow(/via edge does not match/);
    const badGraph = makeAudit(report => { report.vulnerabilities['@expo/cli'].via.push('missing-advisory-root'); });
    expect(() => evaluate({ raw: badGraph })).toThrow(/Unresolved npm audit meta finding/);
    const missingNode = makeAudit(report => { report.vulnerabilities.zod.nodes = ['node_modules/missing/zod']; });
    expect(() => evaluate({ raw: missingNode })).toThrow(/npm audit omitted a known affected lock node/);
  });
});

describe('structural controls and current-build evidence', () => {
  it('requires reassessment when installed code on an accepted tooling call path changes', () => {
    const directory = cloneProject();
    installAuditPackages(directory);
    expect(() => verifyReviewedToolingSources(directory)).not.toThrow();
    writeFileSync(join(directory, 'node_modules/@expo/config/build/Config.js'), 'module.exports = require("deepmerge");');
    expect(() => verifyReviewedToolingSources(directory)).toThrow(/call path changed/);
  });
  it('refuses to attest an export when runtime inputs changed during bundling', () => {
    const directory = cloneProject(), file = join(directory, 'supabase/functions/_shared/client-error-schema.ts');
    expect(() => runExport(['--platform', 'web', '--output-dir', 'export'], { directory, environment: {}, run: () => {
      writeFileSync(file, readFileSync(file, 'utf8') + '\n// concurrent edit\n');
      return { status: 0 };
    } })).toThrow(/inputs changed while the build was running/);
    expect(existsSync(join(directory, 'export/security-export.json'))).toBe(false);
  });
  it.each([
    ['skipped security step', text => text.replace('run: node scripts/security-policy-gate.mjs --bundles .expo/security-export', 'run: node scripts/security-policy-gate.mjs --bundles .expo/security-export\n        continue-on-error: true')],
    ['skipped database job', text => text.replace('  database:\n', '  database:\n    if: false\n')],
    ['suppressed gate exit', text => text.replace('node scripts/security-policy-gate.mjs --bundles .expo/security-export', 'node scripts/security-policy-gate.mjs --bundles .expo/security-export || true')],
    ['missing database checks', text => text.replace('npm run test:backend:isolated', 'echo backend checks skipped')],
    ['dotenv override', text => text.replace('      - run: npm run build:web', "      - run: npm run build:web\n        env:\n          EXPO_NO_DOTENV: '0'")],
    ['stale checkout', text => text.replace('          persist-credentials: false', '          persist-credentials: false\n          ref: old-branch')],
  ])('rejects a workflow that weakens mandatory checks: %s', (_label, change) => {
    const directory = cloneProject(), file = join(directory, '.github/workflows/ci.yml');
    writeFileSync(file, change(readFileSync(file, 'utf8').replaceAll('\r\n', '\n')));
    expect(() => verifyToolingConditions({ directory, environment: {} })).toThrow();
  });

  it('prepares dependencies before the receipt script imports gate modules in its isolated job', () => {
    const workflow = readFileSync(join(root, '.github/workflows/release-acceptance.yml'), 'utf8');
    const decision = workflow.slice(workflow.indexOf('\n  decision:'));
    expect(decision).toMatch(/actions\/setup-node@[a-f0-9]{40}/);
    expect(decision.indexOf('run: npm ci')).toBeGreaterThan(0);
    expect(decision.indexOf('run: npm ci')).toBeLessThan(decision.indexOf('run: node scripts/release-decision.mjs'));
  });
  it('passes ordinary app, test and helper edits without old file-hash agreement while requiring a fresh provenance hash', () => {
    const directory = cloneProject();
    mkdirSync(join(directory, 'src'), { recursive: true });
    const before = exportInputSha256(directory);
    writeFileSync(join(directory, 'src/new-screen.tsx'), 'export default function Screen(){return null;}');
    writeFileSync(join(directory, 'scripts/generate-service-worker.mjs'), '// harmless helper implementation update');
    expect(verifyToolingConditions({ directory, environment: {} })).toEqual(conditions);
    expect(exportInputSha256(directory)).not.toBe(before);
  });

  it('rejects changed action provenance, workflow credential access and permission escalation', () => {
    const directory = cloneProject();
    const workflow = join(directory, '.github/workflows/ci.yml');
    const original = readFileSync(workflow, 'utf8');
    writeFileSync(workflow, original.replace(/actions\/checkout@([a-f0-9]{40})/, 'actions/checkout@' + '0'.repeat(40)));
    expect(() => verifyToolingConditions({ directory, environment: {} })).toThrow(/unreviewed action source/);
    writeFileSync(workflow, original + '\n# secrets.TOKEN\n');
    expect(() => verifyToolingConditions({ directory, environment: {} })).toThrow(/credentials or an unsafe/);
    writeFileSync(workflow, original.replace(/permissions:\r?\n  contents: read/, 'permissions:\n  contents: write'));
    expect(() => verifyToolingConditions({ directory, environment: {} })).toThrow(/read-only repository permissions/);
  });

  it('rejects signing configuration, privileged environment, Node preload and executable Expo config', () => {
    const directory = cloneProject();
    const appPath = join(directory, 'app.json');
    const app = JSON.parse(readFileSync(appPath, 'utf8'));
    app.expo.updates = { ...(app.expo.updates ?? {}), codeSigningCertificate: './certificate.pem' };
    writeFileSync(appPath, JSON.stringify(app));
    expect(() => verifyToolingConditions({ directory, environment: {} })).toThrow(/Code-signing/);
    writeFileSync(appPath, readFileSync(join(root, 'app.json')));
    expect(() => verifyToolingConditions({ directory, environment: { SUPABASE_SERVICE_ROLE_KEY: 'test' } })).toThrow(/credentials/);
    expect(() => verifyToolingConditions({ directory, environment: { NODE_OPTIONS: '--import=unreviewed' } })).toThrow(/Node preload/);
    writeFileSync(join(directory, 'app.config.js'), 'export default {};');
    expect(() => verifyToolingConditions({ directory, environment: {} })).toThrow(/Dynamic Expo config/);
  });

  it('keeps the unsigned Expo command allowlist closed to signing, hosting and dev-server options', () => {
    expect(exportArguments(['--platform', 'web', '--clear', '--output-dir', 'dist']))
      .toEqual(['export', '--platform', 'web', '--clear', '--output-dir', 'dist']);
    for (const args of [['--private-key-path', 'key.pem'], ['--platform', 'web', '--host', 'lan'], ['--output-dir', 'dist']])
      expect(() => exportArguments(args)).toThrow(/Unsupported|Explicit platform/);
  });

  it('checks all current platform source maps and blocks a reviewed-risk package in any client bundle', () => {
    const directory = temporaryDirectory();
    makeBundles(directory, directory);
    expect(verifyBundles([directory]).map(row => row.platform).sort()).toEqual(['android', 'ios', 'web']);
    writeFileSync(join(directory, '_expo/static/js/ios/entry.js.map'), JSON.stringify({ version: 3, sources: ['node_modules/deepmerge/index.js'] }));
    expect(() => verifyBundles([directory])).toThrow(/present in the ios client bundle/);
    writeFileSync(join(directory, '_expo/static/js/ios/entry.js.map'), '{');
    expect(() => verifyBundles([directory])).toThrow(/Invalid source map/);
  });

  it('resolves sourceRoot before checking source-map package exposure', () => {
    const directory = temporaryDirectory();
    makeBundles(directory, directory);
    writeFileSync(join(directory, '_expo/static/js/ios/entry.js.map'), JSON.stringify({ version: 3,
      sourceRoot: 'node_modules/zod/', sources: ['index.js'] }));
    expect(() => verifyBundles([directory])).toThrow(/present in the ios client bundle/);
  });

  it('rejects an unreported nested install of a reviewed-risk package', () => {
    const directory = cloneProject();
    installAuditPackages(directory);
    const nested = join(directory, 'node_modules/expo/node_modules/zod');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'zod', version: '3.25.76' }));
    expect(() => verifyInstalledPackages(JSON.parse(rawAudit), lock, directory)).toThrow(/Unrecorded installed/);
  });

  it('rejects a symlink substituted for an installed risk package', () => {
    const directory = cloneProject(), target = temporaryDirectory();
    installAuditPackages(directory);
    const node = join(directory, 'node_modules/zod');
    writeFileSync(join(target, 'package.json'), readFileSync(join(node, 'package.json')));
    rmSync(node, { recursive: true });
    symlinkSync(target, node, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => verifyInstalledPackages(JSON.parse(rawAudit), lock, directory)).toThrow(/symlinked/);
  });

  it('binds each export to current source inputs, package inputs and actual artifact bytes', () => {
    const project = cloneProject(), output = join(project, 'export');
    makeBundles(output, project);
    const maps = verifyBundles([output]);
    expect(() => verifyExportEvidence([output], project, lockBytes, manifestBytes, maps)).not.toThrow();
    writeFileSync(join(output, '_expo/static/js/web/entry.js'), 'tampered');
    expect(() => verifyExportEvidence([output], project, lockBytes, manifestBytes, maps)).toThrow(/artifact hash changed/);
  });

  it('rejects old bundle evidence after a public build flag or configuration changes', () => {
    const project = cloneProject(), output = join(project, 'export');
    makeBundles(output, project);
    const maps = verifyBundles([output]);
    expect(() => verifyExportEvidence([output], project, lockBytes, manifestBytes, maps,
      { EXPO_PUBLIC_CLIENT_DIAGNOSTICS_ENABLED: 'true' })).toThrow(/Build configuration/);
    expect(exportEnvironmentSha256({ EXPO_PUBLIC_BUILD: 'one', UNRELATED_SECRET: 'first' }))
      .toBe(exportEnvironmentSha256({ UNRELATED_SECRET: 'second', EXPO_PUBLIC_BUILD: 'one' }));
  });

  it('checks installed audit packages against the current lock and rejects symlink substitutions', () => {
    const directory = cloneProject();
    const report = JSON.parse(rawAudit);
    installAuditPackages(directory, report);
    expect(() => verifyInstalledPackages(report, lock, directory)).not.toThrow();
    const node = report.vulnerabilities.zod.nodes[0];
    writeFileSync(join(directory, node, 'package.json'), JSON.stringify({ name: 'zod', version: '9.9.9' }));
    expect(() => verifyInstalledPackages(report, lock, directory)).toThrow(/does not match package-lock/);
    writeFileSync(join(directory, node, 'package.json'), JSON.stringify({ name: 'wrong-name', version: lock.packages[node].version }));
    expect(() => verifyInstalledPackages(report, lock, directory)).toThrow(/does not match package-lock/);
  });
});

describe('release decision and end-to-end gate', () => {
  it.each(['failure', 'skipped', 'cancelled', 'in_progress'])('cannot issue a receipt while a required job is %s', status => {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    for (const name of ['static', 'database', 'security']) {
      const results = { static: { result: 'success' }, database: { result: 'success' }, security: { result: 'success' } };
      results[name].result = status;
      const result = spawnSync(process.execPath, ['scripts/release-decision.mjs'], { cwd: root, encoding: 'utf8',
        env: { ...process.env, ACCEPTANCE_COMMIT: commit, ACCEPTANCE_RESULTS: JSON.stringify(results) }, windowsHide: true });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Required release job ' + name + ' did not succeed');
    }
  });
  it('keeps release acceptance synchronized with clean and accepted-risk decisions', () => {
    const commit = 'a'.repeat(40);
    const output = status => ({
      commit,
      status, npmAudit: status === 'PASS' ? 'PASS' : 'FAIL', policySha256: sha256(readFileSync(join(root, 'scripts/security-policy.json'))),
      lockSha256: sha256(lockBytes), manifestSha256: sha256(manifestBytes),
      acceptedRiskIds: JSON.stringify(status === 'PASS' ? [] : ['GHSA-gcqx-w48m-w2h4', 'GHSA-mrhx-c7xc-m3w5']),
    });
    expect(verifySecurityAcceptance(output('PASS WITH ACCEPTED RISKS'), readFileSync(join(root, 'scripts/security-policy.json')), lockBytes, manifestBytes, commit))
      .toMatchObject({ status: 'PASS WITH ACCEPTED RISKS', npmAudit: 'FAIL' });
    expect(() => verifySecurityAcceptance(output('PASS'), readFileSync(join(root, 'scripts/security-policy.json')), lockBytes, manifestBytes, commit))
      .toThrow(/known affected lock nodes/);
    const cleanManifest = Buffer.from(JSON.stringify({ name: 'remediated', version: '1.0.0' }));
    const cleanLock = Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: { '': JSON.parse(cleanManifest) } }));
    expect(verifySecurityAcceptance({ ...output('PASS'), lockSha256: sha256(cleanLock), manifestSha256: sha256(cleanManifest) },
      readFileSync(join(root, 'scripts/security-policy.json')), cleanLock, cleanManifest, commit))
      .toMatchObject({ status: 'PASS', npmAudit: 'PASS', acceptedRiskIds: [] });
    expect(() => verifySecurityAcceptance({ ...output('PASS WITH ACCEPTED RISKS'), acceptedRiskIds: JSON.stringify(['GHSA-mrhx-c7xc-m3w5']) },
      readFileSync(join(root, 'scripts/security-policy.json')), lockBytes, manifestBytes, commit)).toThrow(/known affected lock nodes/);
    expect(() => verifySecurityAcceptance({ ...output('PASS'), npmAudit: 'FAIL' }, readFileSync(join(root, 'scripts/security-policy.json')), lockBytes, manifestBytes, commit))
      .toThrow(/clean raw npm audit/);
    expect(() => verifySecurityAcceptance({ ...output('PASS WITH ACCEPTED RISKS'), lockSha256: '0'.repeat(64) }, readFileSync(join(root, 'scripts/security-policy.json')), lockBytes, manifestBytes, commit))
      .toThrow(/lock changed/);
    expect(() => verifySecurityAcceptance({ ...output('PASS WITH ACCEPTED RISKS'), commit: 'b'.repeat(40) }, readFileSync(join(root, 'scripts/security-policy.json')), lockBytes, manifestBytes, commit))
      .toThrow(/another commit/);
  });

  it.each(['2026-11-08T10:32:09.000Z', '2035-01-01T00:00:00.000Z'])('runs the full gate with current bundles independently of calendar time (%s)', async time => {
    const directory = cloneProject(), output = join(directory, '.expo/security-policy'), bundleDirectory = join(directory, 'export');
    writeFileSync(join(directory, 'package-lock.json'), lockBytes);
    installAuditPackages(directory);
    makeBundles(bundleDirectory, directory);
    const upstream = fakeUpstream();
    const fetchImpl = async url => {
      const risk = acceptedRows.find(row => url.endsWith(row.id) || url.endsWith(encodeURIComponent(row.package)));
      const payload = risk && (url.includes('api.github.com/') ? upstream[risk.id]?.advisory : upstream[risk.id]?.registry);
      return new Response(JSON.stringify(payload), { status: payload ? 200 : 404 });
    };
    const result = await runGate({ directory, output, bundleDirectories: [bundleDirectory], environment: {},
      revision: () => 'a'.repeat(40),
      clock: () => Date.parse(time), fetchImpl,
      audit: async () => ({ stdout: rawAudit, stderr: 'npm audit reports the current accepted findings', exitCode: 1 }) });
    expect(result).toMatchObject({ status: 'PASS WITH ACCEPTED RISKS', npmAudit: 'FAIL', acceptedRiskIds: ['GHSA-gcqx-w48m-w2h4', 'GHSA-mrhx-c7xc-m3w5'] });
    expect(readFileSync(join(output, 'npm-audit.json'), 'utf8')).toBe(rawAudit);
    expect(JSON.parse(readFileSync(join(output, 'policy-result.json'), 'utf8')).generatedAt).toBe(time);
  });

  it('records raw audit data and fails closed for an unknown advisory in the end-to-end gate', async () => {
    const directory = cloneProject(), output = join(directory, '.expo/security-policy'), bundleDirectory = join(directory, 'export');
    writeFileSync(join(directory, 'package-lock.json'), lockBytes);
    installAuditPackages(directory);
    makeBundles(bundleDirectory, directory);
    const unknown = makeAudit(report => {
      const row = structuredClone(report.vulnerabilities.zod);
      row.name = 'unknown-package'; row.nodes = ['node_modules/unknown-package']; row.effects = [];
      row.via = [{ ...row.via[0], name: row.name, dependency: row.name, url: 'https://github.com/advisories/GHSA-new1-new2-new3' }];
      report.vulnerabilities[row.name] = row;
    });
    const result = await runGate({ directory, output, bundleDirectories: [bundleDirectory], environment: {},
      audit: async () => ({ stdout: unknown, stderr: '', exitCode: 1 }), fetchImpl: async () => new Response('{}') });
    expect(result.status).toBe('FAIL');
    expect(result.npmAudit).toBe('FAIL');
    expect(readFileSync(join(output, 'npm-audit.json'), 'utf8')).toBe(unknown);
    expect(result.error).toMatch(/Unknown, remediated or unreviewed advisory/);
  });

  it('does not allow a fabricated clean audit to hide known affected package-lock nodes', async () => {
    const directory = cloneProject(), output = join(directory, '.expo/security-policy');
    writeFileSync(join(directory, 'package-lock.json'), lockBytes);
    const result = await runGate({ directory, output, environment: {},
      audit: async () => ({ stdout: cleanAudit(), stderr: '', exitCode: 0 }) });
    expect(result).toMatchObject({ status: 'FAIL', npmAudit: 'PASS' });
    expect(result.error).toMatch(/npm audit omitted a known affected lock node/);
    expect(readFileSync(join(output, 'npm-audit.json'), 'utf8')).toBe(cleanAudit());
  });
});
