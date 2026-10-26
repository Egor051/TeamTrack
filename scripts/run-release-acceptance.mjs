// The existing local stack supplies only schemas/services. All SQL writes
// belong to this process's disposable, digest-pinned tmpfs PostgreSQL.
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJournal, evidenceDirectory, failure } from './release-ci-process.mjs';
import { releaseSuites } from './release-acceptance-plan.mjs';
import { preparePostgresImage, postgresImage } from './release-postgres-image.mjs';

const succeeded = (result) => result.exitCode === 0 && !result.timedOut && !result.error;
const requireCommand = (result, type) => {
  if (!succeeded(result)) throw failure(type, result.stderr || result.error || type);
  return result.stdout.trim();
};

export async function runAcceptance(requested = [], options = {}) {
  const journal = createJournal('runner.json', { ...options, suites: releaseSuites });
  const environment = options.environment ?? process.env;
  const name = 'tasktrace-security-postgres-' + process.pid;
  const owner = randomUUID();
  const results = [];
  let createAttempted = false, primaryError = null;
  journal.data.image = { version: postgresImage.version, originalIndex: postgresImage.originalIndex,
    expectedManifests: postgresImage.platforms, repositories: postgresImage.repositories, registry: null };
  Object.assign(journal.data.environment, { container: name, owner });
  journal.save();
  const docker = (stage, args, timeoutMs = 10_000) => journal.command(stage, 'docker', args, { timeoutMs });
  const state = async () => {
    // Read only ownership/state, never container environment credentials.
    const r = await docker('container-state', ['inspect', name, '--format', '{"Config":{"Labels":{{json .Config.Labels}}},"State":{{json .State}}}']);
    if (!succeeded(r)) {
      if (/no such (object|container)/i.test(r.stderr)) return null;
      throw failure('CONTAINER_INSPECTION', r.stderr || r.error || 'Cannot inspect owned container');
    }
    try { return JSON.parse(r.stdout); } catch { throw failure('CONTAINER_INSPECTION', 'Malformed container metadata'); }
  };
  try {
    if (requested.some((label) => !releaseSuites.some((suite) => suite[0] === label)) || new Set(requested).size !== requested.length)
      throw failure('INVALID_SUITE', 'Unknown or duplicate release acceptance suite');
    if (environment.GITHUB_ACTIONS === 'true' && requested.length)
      throw failure('INCOMPLETE_PLAN', 'CI must execute all 18 mandatory suites');
    const selected = releaseSuites.filter(([label]) => !requested.length || requested.includes(label));
    journal.data.selectedSuites = selected.map(([label]) => label); journal.save();
    const inventory = requireCommand(await docker('provider-inventory', ['ps', '--filter', 'name=supabase_db_', '--format', '{{.Names}}']), 'PROVIDER_INVENTORY');
    const providers = inventory.split(/\r?\n/).filter(Boolean);
    if (providers.length !== 1 || !/^supabase_db_[A-Za-z0-9_-]+$/.test(providers[0]))
      throw failure('PROVIDER_INVENTORY', 'Exactly one existing LOCAL schema provider is required');
    const provider = providers[0];
    const network = requireCommand(await docker('provider-network', ['inspect', provider, '--format', '{{.HostConfig.NetworkMode}}']), 'PROVIDER_NETWORK');
    if (!/^[A-Za-z0-9_.-]+$/.test(network) || ['host', 'none'].includes(network))
      throw failure('PROVIDER_NETWORK', 'An isolated local Docker network is required');
    const providerImage = requireCommand(await docker('provider-image', ['inspect', provider, '--format', '{{.Config.Image}}']), 'PROVIDER_IMAGE');
    Object.assign(journal.data.environment, { provider, providerImage, network }); journal.save();
    const image = await preparePostgresImage(journal, options);
    const existing = await docker('container-collision', ['inspect', name, '--format', '{{json .}}']);
    if (succeeded(existing)) throw failure('CONTAINER_COLLISION', 'Refusing to reuse or remove an existing container');
    if (!/no such (object|container)/i.test(existing.stderr)) throw failure('CONTAINER_INSPECTION', existing.stderr || 'Container name could not be checked');
    createAttempted = true;
    const created = await docker('container-start', ['run', '-d', '--pull=never', '--platform', image.platform, '--name', name,
      '--label', 'tasktrace.release-owner=' + owner, '--network', network, '-p', '127.0.0.1::5432',
      '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_PASSWORD=postgres', image.reference,
      'postgres', '-D', '/etc/postgresql', '-c', 'listen_addresses=*'], 30_000);
    requireCommand(created, 'CONTAINER_START');
    Object.assign(journal.data.environment, { owned: true, created: true, cleanup: 'REQUIRED' }); journal.save();
    const deadline = journal.now() + 60_000;
    while (journal.now() < deadline) {
      const probe = await docker('postgres-readiness', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], 5000);
      if (succeeded(probe)) { journal.data.environment.ready = true; journal.save(); break; }
      const actual = await state();
      if (!actual || !actual.State?.Running) throw failure('CONTAINER_EXITED', 'Disposable PostgreSQL exited before readiness');
      await (options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))))(200);
    }
    if (!journal.data.environment.ready) throw failure('READINESS_TIMEOUT', 'PostgreSQL did not become ready within 60 seconds');
    const version = requireCommand(await docker('postgres-version', ['exec', name, 'psql', '-X', '-A', '-t', '-U', 'postgres', '-d', 'postgres', '-c', 'show server_version;']), 'POSTGRES_VERSION');
    if (!/^17\.11(?:\s|$)/.test(version)) throw failure('POSTGRES_VERSION', 'Reviewed PostgreSQL 17.11 is required');
    journal.data.image.serverVersion = version; journal.save();
    for (const [label, script, ...args] of selected) {
      const started = journal.now(), logPath = resolve(journal.directory, label + '.log');
      if (existsSync(logPath)) {
        const attempts = resolve(journal.directory, 'attempts'); mkdirSync(attempts, { recursive: true });
        copyFileSync(logPath, resolve(attempts, label + '-' + started + '.log'));
      }
      writeFileSync(logPath, 'Suite started at ' + new Date(started).toISOString() + '\n');
      const row = journal.data.suites.find((suite) => suite.label === label);
      Object.assign(row, { status: 'RUNNING', startedAt: new Date(started).toISOString() }); journal.save();
      const childEnvironment = { ...environment, TASKTRACE_SECURITY_POSTGRES_CONTAINER: name, EXPO_NO_DOTENV: '1' };
      // The crash suite owns its separate process/server and schema provider.
      if (label === 'crash') delete childEnvironment.TASKTRACE_SECURITY_POSTGRES_CONTAINER;
      const result = await journal.command('suite:' + label, process.execPath, [script, ...args], { environment: childEnvironment, timeoutMs: 600_000 });
      writeFileSync(logPath, result.stdout + '\n' + result.stderr);
      Object.assign(row, { status: succeeded(result) ? 'PASS' : 'FAIL', exitCode: result.exitCode, timedOut: !!result.timedOut,
        elapsedMs: journal.now() - started, finishedAt: new Date(journal.now()).toISOString() });
      results.push({ label, script, args, exitCode: succeeded(result) ? 0 : (result.exitCode || 1), elapsedMs: row.elapsedMs,
        image: label === 'crash' ? providerImage : image.reference });
      writeFileSync(resolve(journal.directory, 'results-' + (requested.join('-') || 'all') + '.json'), JSON.stringify(results, null, 2) + '\n');
      journal.save();
      if (!options.quiet) console.log(label + ' exit=' + row.exitCode + ' ms=' + row.elapsedMs);
    }
    if (results.length !== selected.length || results.some((result) => result.exitCode !== 0))
      throw failure('SUITE_FAILURE', 'At least one required suite did not complete successfully');
    journal.data.status = requested.length && selected.length !== releaseSuites.length ? 'PARTIAL' : 'PASS';
  } catch (error) {
    primaryError = error; journal.fail(error);
  } finally {
    if (createAttempted) {
      try {
        const actual = await state();
        if (actual) {
          const owned = actual.Config?.Labels?.['tasktrace.release-owner'] === owner;
          Object.assign(journal.data.environment, { created: true, owned, lastState: actual.State });
          if (!owned) throw failure('CLEANUP_OWNERSHIP', 'Refusing to remove a container without this invocation owner label');
          if (primaryError) await docker('container-failure-logs', ['logs', '--tail', '150', name]);
          requireCommand(await docker('container-cleanup', ['rm', '-f', name], 30_000), 'CLEANUP_FAILED');
          journal.data.environment.cleanup = 'REMOVED_OWNED_CONTAINER';
        } else journal.data.environment.cleanup = 'NOT_CREATED';
      } catch (error) {
        journal.data.environment.cleanup = 'FAILED_OR_NOT_OWNED';
        journal.data.cleanupFailure = { type: error.type ?? 'CLEANUP_FAILED', message: error.message };
        if (!primaryError) { primaryError = error; journal.fail(error); }
      }
    }
    journal.data.finishedAt = new Date(journal.now()).toISOString();
    journal.data.unstartedSuites = journal.data.suites.filter((suite) => suite.status === 'NOT_STARTED').map((suite) => suite.label);
    journal.save();
  }
  return { exitCode: primaryError ? 1 : 0, evidence: journal.data, results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runAcceptance(process.argv.slice(2), { directory: evidenceDirectory });
  console.log('Release database: ' + result.evidence.status + (result.evidence.failure ? '; ' + result.evidence.failure.type + ': ' + result.evidence.failure.message : ''));
  process.exitCode = result.exitCode;
}
