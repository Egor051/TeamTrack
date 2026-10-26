import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { createJournal, runProcess, sanitize } from '../scripts/release-ci-process.mjs';
import { preparePostgresImage, postgresImage } from '../scripts/release-postgres-image.mjs';
import { runAcceptance } from '../scripts/run-release-acceptance.mjs';
import { runDatabaseStage } from '../scripts/release-database-stage.mjs';
import { releaseSuites } from '../scripts/release-acceptance-plan.mjs';
import { expectedProviderDiagnostic } from '../scripts/browser-error-evidence.mjs';

const directories = [];
it('keeps unhandled errors blocking while classifying only the proved WebKit local RPC console diagnostic', () => {
  const origin='http://127.0.0.1:54321';
  const record={engine:'webkit',name:'Fetch API cannot load http',message:'/127.0.0.1:54321/rest/v1/rpc/pull_task_item_changes_v2 due to access control checks.'};
  expect(expectedProviderDiagnostic(record,origin)).toBe(true);
  for(const changed of [
    {...record,engine:'chromium'},
    {...record,name:'Unhandled Promise Rejection'},
    {...record,name:'TypeError'},
    {...record,message:record.message.replace('54321','54322')},
    {...record,message:record.message.replace('127.0.0.1','example.com')},
    {...record,message:record.message.replace('/rest/v1/rpc/','/auth/v1/')},
    {...record,message:'Context is stopped'},
    {...record,message:'Failed to store record in an IDBObjectStore: The transaction is inactive or finished.'},
  ])expect(expectedProviderDiagnostic(changed,origin)).toBe(false);
  expect(expectedProviderDiagnostic(record,'https://127.0.0.1:54321')).toBe(false);
});
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    expect(target.startsWith(resolve(tmpdir(), 'tasktrace-ci-startup-'))).toBe(true);
    rmSync(target, { recursive: true, force: true });
  }
});
const directory = () => { const path = mkdtempSync(resolve(tmpdir(), 'tasktrace-ci-startup-')); directories.push(path); return path; };
const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
const failed = (stderr, more = {}) => ({ exitCode: 1, stdout: '', stderr, ...more });

function rig(scenario = {}) {
  const out = directory(), commands = [], pulls = [], removed = [];
  let ticks = 0, pulled = !!scenario.cached, created = false, owner;
  const spec = postgresImage.platforms['linux/amd64'];
  const environment = { GITHUB_ACTIONS: 'true', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '321', GITHUB_RUN_ATTEMPT: '1' };
  const execute = async (command, args) => {
    ticks += 1; commands.push({ command, args });
    if (command !== 'docker') return args[0] === scenario.suiteFailure ? failed('Synthetic suite failure') : ok('suite completed');
    if (args[0] === 'info') return ok(scenario.platform ?? 'linux/x86_64');
    if (args[0] === 'image') {
      if (!pulled || scenario.incomplete) return failed('Error: No such image');
      const manifest = scenario.badDigest ? 'sha256:' + '0'.repeat(64) : spec.manifest;
      return ok(JSON.stringify({ Id: spec.config, Os: 'linux', Architecture: scenario.badArchitecture ? 'arm64' : 'amd64',
        RepoDigests: [args[2]], Descriptor: { digest: manifest } }));
    }
    if (args[0] === 'pull') {
      pulls.push(args.at(-1));
      const result = scenario.pullResults?.[pulls.length - 1] ?? ok('download complete');
      if (result.exitCode === 0) pulled = true;
      return result;
    }
    if (args[0] === 'ps') return scenario.noProvider ? ok('') : ok('supabase_db_test');
    if (args[0] === 'inspect' && args[1] === 'supabase_db_test') return ok(args.at(-1).includes('NetworkMode') ? 'test-network' : 'provider:unchanged');
    if (args[0] === 'inspect') {
      if (!created && !scenario.collision) return failed('Error: No such object');
      return ok(JSON.stringify({ Config: { Labels: { 'tasktrace.release-owner': scenario.collision || scenario.foreignOwner ? 'foreign' : owner } }, State: { Running: !scenario.exited, Status: scenario.exited ? 'exited' : 'running' } }));
    }
    if (args[0] === 'run') {
      owner = args[args.indexOf('--label') + 1].split('=').at(-1);
      created = !scenario.startFailure || !!scenario.partialContainer;
      return scenario.startFailure ? failed('Container startup rejected') : ok('owned-container-id');
    }
    if (args[0] === 'exec') return args.includes('pg_isready') ? (scenario.notReady || scenario.exited ? failed('not ready') : ok('accepting connections')) : ok('17.11');
    if (args[0] === 'logs') return ok('PostgreSQL startup diagnostic');
    if (args[0] === 'rm') { removed.push(args.at(-1)); created = false; return ok('removed'); }
    throw Error('Unexpected test command ' + args.join(' '));
  };
  const options = { directory: out, execute, environment, now: () => ticks, sleep: async (ms) => { ticks += scenario.notReady ? 60_000 : ms; }, quiet: true };
  return { out, commands, pulls, removed, options, journal: () => createJournal('image.json', options) };
}

describe('pinned PostgreSQL acquisition', () => {
  it('reuses a verified cache without network and rejects an unsupported platform', async () => {
    const cached = rig({ cached: true });
    expect((await preparePostgresImage(cached.journal(), cached.options)).reference).toContain('@sha256:');
    expect(cached.pulls).toEqual([]);
    const foreign = rig({ platform: 'linux/ppc64le' });
    await expect(preparePostgresImage(foreign.journal(), foreign.options)).rejects.toMatchObject({ type: 'UNSUPPORTED_PLATFORM' });
    expect(foreign.pulls).toHaveLength(0);
  });
  it('bounds 429 retries and fails over only to the identical official digest', async () => {
    const r = rig({ pullResults: [failed('429 toomanyrequests: Data limit exceeded'), failed('429 rate exceeded'), ok()] });
    const journal = r.journal(), result = await preparePostgresImage(journal, r.options);
    expect(result.reference).toMatch(/^public\.ecr\.aws\/supabase\/postgres@sha256:/);
    expect(r.pulls).toHaveLength(3);
    expect(new Set(r.pulls.map((ref) => ref.split('@')[1]))).toEqual(new Set([postgresImage.platforms['linux/amd64'].manifest]));
    expect(journal.data.attempts.slice(0, 2).every((row) => row.classification === 'TRANSIENT' && row.stderr.includes('429'))).toBe(true);
  });
  it.each(['network is unreachable', '429 Too Many Requests', 'unexpected EOF'])('never starts a database after exhausted %s', async (message) => {
    const r = rig({ pullResults: [failed(message), failed(message), failed(message)] });
    const result = await runAcceptance([], r.options);
    expect(result.exitCode).toBe(1); expect(result.evidence.failure.type).toBe('IMAGE_PULL_EXHAUSTED');
    expect(result.evidence.unstartedSuites).toHaveLength(18); expect(r.pulls).toHaveLength(3);
    expect(r.commands.some(({ args }) => args[0] === 'run')).toBe(false);
    expect(JSON.parse(readFileSync(resolve(r.out, 'runner.json'), 'utf8')).status).toBe('FAIL');
  });
  it.each(['unauthorized', 'manifest unknown', 'x509 certificate rejected'])('does not retry a permanent %s failure', async (message) => {
    const r = rig({ pullResults: [failed(message)] });
    const result = await runAcceptance([], r.options);
    expect(result.exitCode).toBe(1); expect(result.evidence.failure.type).toBe('IMAGE_PULL_PERMANENT');
    expect(r.pulls).toHaveLength(1); expect(r.removed).toHaveLength(0);
  });
  it.each([{ badDigest: true }, { badArchitecture: true }, { incomplete: true }])('fails closed for invalid/partial image %j', async (scenario) => {
    const r = rig(scenario), result = await runAcceptance([], r.options);
    expect(result.exitCode).toBe(1); expect(['IMAGE_INTEGRITY', 'IMAGE_INCOMPLETE']).toContain(result.evidence.failure.type);
    expect(r.pulls).toHaveLength(1); expect(r.commands.some(({ args }) => args[0] === 'run')).toBe(false);
  });
});

describe('database startup, cleanup and truthful evidence', () => {
  it.each([{ startFailure: true }, { startFailure: true, partialContainer: true }, { notReady: true }, { exited: true }, { noProvider: true }])('preserves startup FAIL and every unstarted suite for %j', async (scenario) => {
    const r = rig(scenario), result = await runAcceptance([], r.options);
    expect(result.exitCode).toBe(1); expect(result.evidence.status).toBe('FAIL');
    expect(result.evidence.unstartedSuites).toHaveLength(18);
    expect(JSON.parse(readFileSync(resolve(r.out, 'runner.json'), 'utf8')).failure.type).toBeTruthy();
    expect(r.removed.every((name) => /^tasktrace-security-postgres-\d+$/.test(name))).toBe(true);
    if (scenario.partialContainer || scenario.notReady || scenario.exited) expect(r.removed).toHaveLength(1);
  });
  it.each([{ collision: true }, { foreignOwner: true }])('never removes a container not owned by this invocation: %j', async (scenario) => {
    const r = rig(scenario), result = await runAcceptance([], r.options);
    expect(result.exitCode).toBe(1); expect(r.removed).toHaveLength(0);
  });
  it('requires the actual execution of all 18 suites; one failed suite remains FAIL with diagnostics', async () => {
    const r = rig({ suiteFailure: 'scripts/operation-window-integration.mjs' }), result = await runAcceptance([], r.options);
    expect(result.results).toHaveLength(18); expect(result.exitCode).toBe(1);
    expect(result.evidence.suites.filter((row) => row.status === 'FAIL')).toHaveLength(2);
    expect(result.evidence.unstartedSuites).toEqual([]); expect(r.removed).toHaveLength(1);
  });
  it('records PASS only after all 18 suites and owned cleanup succeed', async () => {
    const r = rig(), result = await runAcceptance([], r.options);
    expect(result.exitCode).toBe(0); expect(result.results).toHaveLength(18);
    expect(result.evidence.suites.every((row) => row.status === 'PASS')).toBe(true);
    expect(result.evidence.environment.cleanup).toBe('REMOVED_OWNED_CONTAINER');
    expect(result.evidence.status).toBe('PASS'); expect(r.removed).toHaveLength(1);
  });
  it('rejects partial, unknown or duplicate CI plans before Docker is invoked', async () => {
    for (const plan of [['v3-fresh'], ['unknown'], ['v3-fresh', 'v3-fresh']]) {
      const r = rig(), result = await runAcceptance(plan, r.options);
      expect(result.exitCode).toBe(1); expect(r.commands).toHaveLength(0);
    }
  });
  it('creates uploadable, sanitized evidence even if npm/Supabase startup fails before the runner', async () => {
    const out = directory();
    const result = await runDatabaseStage('supabase', ['npx', '--yes', 'supabase@2.116.0', 'start'], {
      directory: out, execute: async () => failed('429 Bearer synthetic-credential-value password=fixture-private-value'),
    });
    const raw = readFileSync(resolve(out, 'startup-supabase.json'), 'utf8');
    expect(result.exitCode).toBe(1); expect(JSON.parse(raw).unstartedSuites).toHaveLength(18);
    expect(raw).toContain('429'); expect(raw).not.toContain('synthetic-credential-value'); expect(raw).not.toContain('fixture-private-value');
    expect(JSON.parse(raw).image.expectedManifests['linux/amd64'].manifest).toBe(postgresImage.platforms['linux/amd64'].manifest);
  });
  it('initializes evidence without dependencies before setup-node can fail', async () => {
    const out = directory(), result = await runDatabaseStage('initialize', [], { directory: out });
    expect(result.exitCode).toBe(0); expect(result.evidence.status).toBe('INITIALIZED');
    expect(JSON.parse(readFileSync(resolve(out, 'startup-initialize.json'), 'utf8')).suites).toHaveLength(18);
    const steps = parse(readFileSync('.github/workflows/release-acceptance.yml', 'utf8')).jobs.database.steps;
    expect(steps.findIndex((step) => step.run?.includes('release-database-stage.mjs initialize')))
      .toBeLessThan(steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@')));
  });
  it('preserves startup TIMEOUT as failure and refuses arbitrary commands', async () => {
    const timed = await runDatabaseStage('browsers', ['npx', 'playwright', 'install', '--with-deps', 'chromium', 'webkit'], {
      directory: directory(), execute: async () => failed('timeout', { timedOut: true }),
    });
    expect(timed.exitCode).toBe(1); expect(timed.evidence.failure.type).toBe('STARTUP_TIMEOUT');
    const invalid = await runDatabaseStage('supabase', ['other-command'], { directory: directory(), execute: async () => { throw Error('must not execute'); } });
    expect(invalid.exitCode).toBe(1); expect(invalid.evidence.commands).toHaveLength(0);
  });
  it('keeps startup wrappers before their risky commands and uploads diagnostics without allowing a failed job', () => {
    const workflow = parse(readFileSync('.github/workflows/release-acceptance.yml', 'utf8'));
    const steps = workflow.jobs.database.steps;
    expect(steps[0].with['fetch-depth']).toBe(0);
    for (const name of ['static', 'security', 'decision']) expect(workflow.jobs[name].steps[0].with['fetch-depth']).toBeUndefined();
    for (const stage of ['dependencies', 'supabase', 'browsers']) expect(steps.some((step) => step.run?.includes('release-database-stage.mjs ' + stage + ' -- '))).toBe(true);
    const upload = steps.find((step) => step.with?.name === 'release-database-evidence');
    expect(upload.if).toBe('always()'); expect(upload.with['include-hidden-files']).toBe(true); expect(upload.with['if-no-files-found']).toBe('error');
    expect(upload.with.path).toContain('.expo/audit-fixes/');
    expect(steps.every((step) => step['continue-on-error'] !== true)).toBe(true);
    expect(workflow.jobs.decision.needs).toEqual(['static', 'database', 'security']);
    expect(releaseSuites).toHaveLength(18);
  });
  it('bounds and terminates an actual child with unfinished async work', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 50 });
    expect(result.timedOut).toBe(true); expect(result.exitCode).not.toBe(0);
  });
  it('sanitizes auth headers, credentials and split diagnostic fields', () => {
    const value = 'Bearer fixture-private-header postgres://user:fixture-private-password@localhost token=fixture-private-token';
    const clean = sanitize(value);
    expect(clean).not.toContain('fixture-private'); expect(clean).toContain('[REDACTED]');
    const structured = { Env: ['POSTGRES_PASSWORD=fixture-private-password'], State: { Running: true } };
    expect(JSON.parse(sanitize(JSON.stringify(structured)))).toEqual({ Env: ['POSTGRES_PASSWORD=[REDACTED]'], State: { Running: true } });
  });
});

it.each(['failure', 'cancelled', 'skipped', 'timed_out', undefined])('the unchanged release decision rejects static %s even with successful security', (result) => {
  const run = spawnSync(process.execPath, ['scripts/release-decision.mjs'], { encoding: 'utf8', env: { ...process.env,
    ACCEPTANCE_RESULTS: JSON.stringify({ static: { result }, database: { result: 'success' }, security: { result: 'success' } }),
  } });
  expect(run.status).not.toBe(0); expect(run.stderr).toContain('Required release job static did not succeed');
});
