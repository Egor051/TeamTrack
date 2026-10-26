import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createJournal, failure } from './release-ci-process.mjs';
import { releaseSuites } from './release-acceptance-plan.mjs';
import { postgresImage } from './release-postgres-image.mjs';

const stages = {
  initialize: [],
  dependencies: ['npm', 'ci'],
  supabase: ['npx', '--yes', 'supabase@2.116.0', 'start'],
  browsers: ['npx', 'playwright', 'install', '--with-deps', 'chromium', 'webkit'],
};

export async function runDatabaseStage(label, command, options = {}) {
  const journal = createJournal('startup-' + (Object.hasOwn(stages, label) ? label : 'invalid') + '.json', { ...options, suites: releaseSuites });
  journal.data.image = { version: postgresImage.version, originalIndex: postgresImage.originalIndex,
    expectedManifests: postgresImage.platforms, repositories: postgresImage.repositories, registry: null };
  journal.save();
  try {
    if (!Object.hasOwn(stages, label) || JSON.stringify(command) !== JSON.stringify(stages[label])) throw failure('INVALID_STARTUP_STAGE', 'Only the fixed local CI startup commands are allowed');
    if (label === 'initialize') {
      journal.data.status = 'INITIALIZED'; journal.save();
      return { exitCode: 0, evidence: journal.data };
    }
    const [binary, ...args] = command;
    // On Windows npm/npx are cmd shims; the checked fixed arguments contain
    // no shell syntax. Linux/GitHub invokes the executable directly.
    const result = process.platform === 'win32' && !options.execute
      ? await journal.command(label, process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', binary + ' ' + args.join(' ')], { timeoutMs: 600_000 })
      : await journal.command(label, binary, args, { timeoutMs: 600_000 });
    journal.data.registriesObserved = [...new Set((result.stdout + '\n' + result.stderr).match(/(?:ghcr\.io|public\.ecr\.aws)\/supabase\/[A-Za-z0-9_.:-]+/g) ?? [])];
    if (result.exitCode !== 0 || result.error || result.timedOut) throw failure(result.timedOut ? 'STARTUP_TIMEOUT' : 'STARTUP_COMMAND', result.stderr || result.error || label + ' failed');
    journal.data.status = 'STARTUP_STEP_SUCCEEDED'; journal.save();
    return { exitCode: 0, evidence: journal.data };
  } catch (error) {
    journal.fail(error); return { exitCode: 1, evidence: journal.data };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [label, separator, ...command] = process.argv.slice(2);
  const result = await runDatabaseStage(label, separator === '--' ? command : []);
  const record = result.evidence.commands.at(-1);
  if (record?.stdout) process.stdout.write(record.stdout);
  if (record?.stderr) process.stderr.write(record.stderr);
  console.log('Database startup ' + label + ': ' + result.evidence.status);
  process.exitCode = result.exitCode;
}
