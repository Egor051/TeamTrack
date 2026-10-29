// Verify the properties that protect the unsigned static export and its CI boundary.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
export const CONTROL_FILES = [
  'package.json', 'app.json', 'eas.json',
  'metro.config.js', 'metro.config.cjs', 'metro.config.mjs', 'metro.config.ts', 'metro.config.json',
  'babel.config.js', 'babel.config.cjs', 'babel.config.mjs', 'babel.config.json', 'babel.config.ts',
  '.babelrc', '.babelrc.json', '.babelrc.js', '.babelrc.cjs',
  '.github/workflows/ci.yml', '.github/workflows/release-acceptance.yml',
  'scripts/security-policy-gate.mjs', 'scripts/security-tooling-conditions.mjs',
  'scripts/security-export.mjs', 'scripts/build-compatible-rollback.mjs',
  'scripts/generate-service-worker.mjs',
  'scripts/release-decision.mjs', 'scripts/check-release-workflows.mjs',
];

// Updating a trusted action is a critical supply-chain change; ordinary helper
// and application edits are checked from their current behavior, not file hashes.
export const PINNED_ACTIONS = Object.freeze({
  'actions/checkout': '11d5960a326750d5838078e36cf38b85af677262',
  'actions/setup-node': '49933ea5288caeca8642d1e84afbd3f7d6820020',
  'actions/upload-artifact': 'ea165f8d65b6e75b540449e92b4886f43607fa02',
});

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const checkoutRef = '${{ github.event.pull_request.head.sha || github.sha }}';
const exportCommand = 'node scripts/security-export.mjs --platform web --platform android --platform ios --source-maps --output-dir .expo/security-export';
const gateCommand = 'node scripts/security-policy-gate.mjs --bundles .expo/security-export';
const gateCondition = "always() && steps.dependencies.outcome == 'success'";
const stopCommand = 'npx --yes supabase@2.116.0 stop --no-backup';
const requiredCommands = {
  CI: {
    static: ['npm ci', 'npm run check:db', 'npm run typecheck', 'npm run lint', 'npm run test:unit',
      'npm run build:web', exportCommand, 'npx --yes expo-doctor@1.21.5', gateCommand],
    database: ['npm ci', 'npx --yes supabase@2.116.0 start', 'npm run test:sql -- --fresh',
      'npm run test:sql -- --cron --advisors', 'npm run test:backend:isolated', 'node scripts/run-audit-remediation-tests.mjs',
      'node scripts/audit-followup-integration.mjs', 'node scripts/regression-write-protocol.mjs', 'npm run test:security',
      'node scripts/verify-audit-regressions.mjs', 'npx playwright install --with-deps chromium webkit',
      'node scripts/regression-mutation-browser.mjs',
      'node scripts/run-security-integrations.mjs scripts/audit-remediation-browser.mjs scripts/template-realtime-browser.mjs',
      'node scripts/pwa-mobile-browser-smoke.mjs', 'npx --yes supabase@2.116.0 db lint --local',
      'npx --yes supabase@2.116.0 db advisors --local', stopCommand],
  },
  'Release acceptance': {
    static: ['npm ci', 'npm run check:db', 'npm run typecheck', 'npm run lint -- --no-cache', 'npm run test:unit',
      'node scripts/release-manifest.mjs --check', 'node scripts/check-release-workflows.mjs'],
    database: ['node scripts/release-database-stage.mjs initialize', 'node scripts/release-database-stage.mjs dependencies -- npm ci',
      'node scripts/release-database-stage.mjs supabase -- npx --yes supabase@2.116.0 start',
      'node scripts/release-database-stage.mjs browsers -- npx playwright install --with-deps chromium webkit',
      'node scripts/run-release-acceptance.mjs', 'node scripts/pwa-mobile-browser-smoke.mjs', stopCommand],
    security: ['npm ci', 'npm run build:web', exportCommand, 'node scripts/release-bundle-exposure.mjs .expo/security-export',
      'npx --yes expo-doctor@1.21.5', gateCommand],
    decision: ['npm ci', 'node scripts/release-decision.mjs'],
  },
};

export function exportInputSha256(directory = root) {
  // This pure contract is imported by both the app and the Edge handler.
  // Keep it in the app's input fingerprint despite its Supabase directory.
  const files = new Set([...CONTROL_FILES, 'package-lock.json', 'tsconfig.json',
    'supabase/functions/_shared/client-error-schema.ts']);
  const walk = path => {
    if (!existsSync(path)) return;
    assert(!lstatSync(path).isSymbolicLink(), 'Symlink in export inputs');
    if (lstatSync(path).isDirectory()) for (const name of readdirSync(path)) walk(resolve(path, name));
    else files.add(relative(directory, path).replaceAll('\\', '/'));
  };
  for (const name of ['src', 'assets', 'public']) walk(resolve(directory, name));
  const digest = createHash('sha256');
  for (const file of [...files].sort()) {
    const path = resolve(directory, file); digest.update(file + '\0');
    if (!existsSync(path)) { digest.update('absent\0'); continue; }
    const bytes = readFileSync(path);
    digest.update(/\.(?:[cm]?[jt]sx?|json|css|html|svg)$/.test(extname(file))
      ? bytes.toString('utf8').replaceAll('\r\n', '\n') : bytes);
  }
  return digest.digest('hex');
}

export function exportEnvironmentSha256(environment = {}) {
  const inputs = { ...environment, EXPO_NO_DOTENV: '1' };
  const entries = Object.keys(inputs).filter(key => key.startsWith('EXPO_') || ['NODE_ENV', 'BABEL_ENV'].includes(key))
    .sort().map(key => [key, inputs[key]]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function verifyWorkflow(source, label) {
  const workflow = parse(source);
  assert(object(workflow) && object(workflow.jobs), label + ' workflow must have jobs');
  assert.deepEqual(workflow.permissions, { contents: 'read' }, label + ' must retain read-only repository permissions');
  assert.equal(workflow.env?.EXPO_NO_DOTENV, '1', label + ' must disable dotenv loading');
  assert(!workflow.defaults, label + ' cannot override the fail-closed command shell');
  for (const event of ['push', 'pull_request']) assert(Object.hasOwn(workflow.on ?? {}, event), label + ' must run on ' + event);
  assert(!/\bsecrets\s*(?:\.|\[)|\bgithub\s*\.\s*token\b|pull_request_target/i.test(source),
    label + ' references privileged credentials or an unsafe pull-request trigger');
  assert(Object.keys(workflow.jobs).length > 0, label + ' must retain CI jobs');
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-latest', label + '/' + jobName + ' must use an isolated hosted runner');
    assert(!job.environment && !job.permissions && !job.uses,
      label + '/' + jobName + ' must not add credentials, permission overrides or an unreviewed reusable workflow');
    assert(Array.isArray(job.steps), label + '/' + jobName + ' must define steps');
    assert.equal(job['continue-on-error'] ?? false, false, label + '/' + jobName + ' cannot ignore job failure');
    assert.equal(job.if, jobName === 'decision' ? 'always()' : undefined, label + '/' + jobName + ' cannot skip required jobs');
    assert(!job.defaults && !job.container, label + '/' + jobName + ' cannot override the isolated execution boundary');
    if (job.env?.EXPO_NO_DOTENV !== undefined) assert.equal(job.env.EXPO_NO_DOTENV, '1', 'Job cannot enable dotenv');
    for (const [index, step] of job.steps.entries()) {
      assert.equal(step['continue-on-error'] ?? false, false, label + ' cannot ignore step failure');
      assert(!step.shell, label + ' must retain the default fail-closed command shell');
      if (step.env?.EXPO_NO_DOTENV !== undefined) assert.equal(step.env.EXPO_NO_DOTENV, '1', 'Step cannot enable dotenv');
      if (step.uses) {
        const match = /^([^@]+)@([a-f0-9]{40})$/.exec(step.uses);
        assert(match, label + '/' + jobName + ' step ' + index + ' must pin an action commit');
        assert.equal(PINNED_ACTIONS[match[1]], match[2],
          label + '/' + jobName + ' uses an unreviewed action source: ' + match[1]);
      }
      if (step.uses?.startsWith('actions/checkout@')) {
        assert.equal(step.with?.['persist-credentials'], false, label + ' checkout must not persist credentials');
        assert.equal(step.with?.ref, checkoutRef, label + ' checkout must verify the exact event SHA');
      }
      assert(!/(?:\beas\s+(?:build|update|submit)\b|\bexpo\s+start\b|--private-key-path|\bvercel\b.*(?:--prod|promote)|\bdb\s+push\b)/i.test(step.run ?? ''),
        label + '/' + jobName + ' includes signing, a development server, deployment or a hosted migration');
    }
  }
  for (const [name, commands] of Object.entries(requiredCommands[label])) {
    const job = workflow.jobs[name];
    assert(job, label + ' is missing required job ' + name);
    let previous = -1;
    for (const command of commands) {
      const index = job.steps.findIndex(step => step.run === command);
      assert(index > previous, label + '/' + name + ' is missing or reordered mandatory command: ' + command);
      const condition = command === gateCommand ? gateCondition : command === stopCommand ? 'always()' : undefined;
      assert.equal(job.steps[index].if, condition, label + '/' + name + ' cannot skip mandatory command: ' + command);
      previous = index;
    }
    for (const step of job.steps) if (step.run) assert(commands.includes(step.run), label + '/' + name + ' has an unreviewed command');
    const setup = job.steps.findIndex(step => step.uses?.startsWith('actions/setup-node@'));
    const dependencies = job.steps.findIndex(step => /\bnpm ci$/.test(step.run ?? ''));
    assert(setup >= 0 && setup < dependencies, label + '/' + name + ' must prepare Node before installing dependencies');
    assert.equal(job.steps[setup].with?.['node-version'], label === 'Release acceptance' && name === 'static' ? '${{ matrix.node }}' : 22,
      label + '/' + name + ' changed the reviewed Node runtime');
  }
  return workflow;
}

export function verifyToolingConditions({ directory = root, environment = process.env } = {}) {
  const json = file => JSON.parse(readFileSync(resolve(directory, file), 'utf8'));
  const manifest = json('package.json'), app = json('app.json').expo;
  assert(app && !app.updates?.codeSigningCertificate && !app.updates?.codeSigningMetadata,
    'Code-signing configuration is outside the unsigned export scope');
  assert(!readdirSync(directory).some(name => /^app\.config\./.test(name)),
    'Dynamic Expo config requires review of executable build inputs');
  assert(!readdirSync(directory).some(name => /^(?:(?:babel|metro)\.config\.|\.babelrc)/.test(name) && !CONTROL_FILES.includes(name)),
    'Unreviewed build config variant requires review of executable build inputs');
  for (const name of ['start', 'android', 'ios', 'web']) {
    assert.equal(manifest.scripts?.[name], 'expo start --localhost' + (name === 'start' ? '' : ' --' + name),
      'Development server must bind to localhost: ' + name);
  }
  assert.equal(manifest.scripts?.['build:web'],
    'node scripts/security-export.mjs --platform web --clear --output-dir dist && node scripts/generate-service-worker.mjs',
    'Web export must use the guarded unsigned export wrapper');

  const forbidden = /^(?:EXPO_TOKEN|EAS_(?:ACCESS_)?TOKEN|EAS_BUILD|APPLE_(?:APP_SPECIFIC_PASSWORD|API_KEY)|ASC_API_KEY(?:_PATH)?|GOOGLE_(?:APPLICATION_CREDENTIALS|SERVICE_ACCOUNT_KEY)|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|SUPABASE_SERVICE_ROLE_KEY)$/i;
  const present = Object.keys(environment).filter(key => forbidden.test(key) && environment[key] && environment[key] !== 'false');
  assert.equal(present.length, 0, 'Privileged signing or cloud credentials are outside this export scope: ' + present.join(', '));
  assert(!/(?:--require|--import|--(?:experimental-)?loader|(?:^|\s)-r)/.test(environment.NODE_OPTIONS ?? ''),
    'Unreviewed Node preload is outside the unsigned export scope');

  const ci = verifyWorkflow(readFileSync(resolve(directory, '.github/workflows/ci.yml'), 'utf8'), 'CI');
  const release = verifyWorkflow(readFileSync(resolve(directory, '.github/workflows/release-acceptance.yml'), 'utf8'), 'Release acceptance');
  assert(ci.jobs.static?.steps.some(step => /security-policy-gate\.mjs/.test(step.run ?? '')),
    'CI must run the mandatory security policy gate');
  assert(release.jobs.security?.steps.some(step => /security-policy-gate\.mjs/.test(step.run ?? '')),
    'Release acceptance must run the mandatory security policy gate');
  assert.deepEqual(release.jobs.decision?.needs, ['static', 'database', 'security'],
    'Release decision must keep all static, database and security jobs mandatory');
  assert.equal(release.jobs.decision?.if, 'always()', 'Release decision must run to fail closed on any required job');
  assert.deepEqual(release.jobs.static.strategy?.matrix?.node, [22, 24], 'Release must verify both supported Node versions');
  for (const event of ['push', 'pull_request']) assert.deepEqual(release.on[event]?.branches, ['main'], 'Release trigger must include main');
  assert(Object.hasOwn(release.on, 'workflow_dispatch'), 'Manual acceptance must remain available');
  for (const [workflow, jobName] of [[ci, 'static'], [release, 'security']])
    assert.equal(workflow.jobs[jobName].steps.find(step => step.run === 'npm ci')?.id, 'dependencies', 'Gate condition must reference dependency installation');
  for (const name of ['status', 'commit', 'npmAudit', 'policySha256', 'lockSha256', 'manifestSha256', 'acceptedRiskIds'])
    assert.equal(release.jobs.security.outputs?.[name], '${{ steps.security-policy.outputs.' + name + ' }}', 'Security output must come from the actual gate: ' + name);
  assert.equal(release.jobs.security.steps.find(step => step.run === gateCommand)?.id, 'security-policy', 'Release security output step is missing');
  const decision = release.jobs.decision.steps.find(step => step.run === 'node scripts/release-decision.mjs');
  assert.equal(decision?.env?.ACCEPTANCE_RESULTS, '${{ toJSON(needs) }}', 'Receipt must consume this run\'s required jobs');
  assert.equal(decision?.env?.ACCEPTANCE_COMMIT, checkoutRef, 'Receipt must identify this event SHA');

  return {
    scope: 'isolated-unsigned-static-export',
    unsignedExportOnly: true,
    signingInputsRejected: true,
    dynamicConfigRejected: true,
    credentialInputsAbsent: true,
    ciPermissionsReadOnly: true,
    actionsPinned: true,
    untrustedWorkflowInputsRejected: true,
    dotenvDisabled: true,
    releaseJobsMandatory: true,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyToolingConditions();
  console.log('PASS unsigned export and CI invariants; signing, privileged inputs and deployment remain outside scope');
}
