// Scope of the temporary exception: isolated, unsigned static exports only.
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
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function controlFileHashes(directory = root) {
  return Object.fromEntries(CONTROL_FILES.map(file => {
    const path = resolve(directory, file);
    if (!existsSync(path)) return [file, null];
    assert(!lstatSync(path).isSymbolicLink(), 'Symlink in exception control: ' + file);
    return [file, hash(readFileSync(path, 'utf8').replaceAll('\r\n', '\n'))];
  }));
}
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
    digest.update(/\.(?:[cm]?[jt]sx?|json|css|html|svg)$/.test(extname(file)) ? bytes.toString('utf8').replaceAll('\r\n', '\n') : bytes);
  }
  return digest.digest('hex');
}
export function verifyToolingConditions({ directory = root, environment = process.env } = {}) {
  const json = file => JSON.parse(readFileSync(resolve(directory, file), 'utf8'));
  const manifest = json('package.json'), app = json('app.json').expo;
  assert(app && !app.updates?.codeSigningCertificate && !app.updates?.codeSigningMetadata,
    'Signing config is outside the approved unsigned-export exception');
  assert(!readdirSync(directory).some(name => /^app\.config\./.test(name)),
    'Dynamic Expo config requires a new exposure review');
  assert(!readdirSync(directory).some(name => /^(?:(?:babel|metro)\.config\.|\.babelrc)/.test(name) && !CONTROL_FILES.includes(name)),
    'Unreviewed build config variant requires a new exposure review');
  for (const name of ['start', 'android', 'ios', 'web']) {
    assert.equal(manifest.scripts?.[name], 'expo start --localhost' + (name === 'start' ? '' : ' --' + name),
      'Dev server must default to localhost: ' + name);
  }
  assert.equal(manifest.scripts?.['build:web'],
    'node scripts/security-export.mjs --platform web --clear --output-dir dist && node scripts/generate-service-worker.mjs',
    'Web export must use the unsigned export guard');
  const forbidden = /^(?:EXPO_TOKEN|EAS_(?:ACCESS_)?TOKEN|EAS_BUILD|APPLE_(?:APP_SPECIFIC_PASSWORD|API_KEY)|ASC_API_KEY(?:_PATH)?|GOOGLE_(?:APPLICATION_CREDENTIALS|SERVICE_ACCOUNT_KEY)|AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)|SUPABASE_SERVICE_ROLE_KEY)$/i;
  const present = Object.keys(environment).filter(key => forbidden.test(key) && environment[key] && environment[key] !== 'false');
  assert.equal(present.length, 0, 'Privileged signing/cloud credentials are outside this exception: ' + present.join(', '));
  assert(!/(?:--require|--import|--(?:experimental-)?loader|(?:^|\s)-r)/.test(environment.NODE_OPTIONS ?? ''),
    'Unreviewed Node preload is outside this exception');
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/release-acceptance.yml']) {
    const source = readFileSync(resolve(directory, file), 'utf8'), workflow = parse(source);
    assert.equal(workflow.permissions?.contents, 'read', 'CI must have read-only repository access');
    assert(Object.entries(workflow.permissions).every(([key, value]) => key === 'contents' && value === 'read'),
      'Additional CI permissions need a new risk review');
    assert.equal(workflow.env?.EXPO_NO_DOTENV, '1', 'CI must disable Expo dotenv loading');
    assert(!/\bsecrets\s*(?:\.|\[)|\bgithub\s*\.\s*token\b|pull_request_target/i.test(source), 'Privileged/untrusted CI inputs are outside this exception');
    for (const job of Object.values(workflow.jobs)) {
      assert.equal(job['runs-on'], 'ubuntu-latest', 'Use isolated hosted CI runners');
      assert(!job.environment && !job.permissions, 'Job credentials/permission overrides require a new review');
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/, 'Pin reviewed CI actions');
        if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with?.['persist-credentials'], false);
        assert(!/(?:\beas\s+(?:build|update|submit)\b|\bexpo\s+start\b|--private-key-path|\bvercel\b.*(?:--prod|promote))/.test(step.run ?? ''),
          'Signing, development servers and publishing are outside acceptance');
      }
    }
  }
  return { scope: 'isolated-unsigned-static-export', defaultDevHost: 'localhost', signingInputsAbsent: true,
    ciCredentialsRestricted: true, dotenv: 'export-wrapper-forces-EXPO_NO_DOTENV=1' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyToolingConditions();
  console.log('PASS unsigned export/CI conditions; privileged signing and networked DevTools are outside this exception');
}
