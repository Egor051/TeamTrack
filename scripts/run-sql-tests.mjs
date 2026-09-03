import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const SUPABASE_CLI = 'supabase@2.116.0';
const run = (args) => {
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npx';
  const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'npx', ...args] : args;
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

function runInLocalPostgres(file) {
  const lookup = spawnSync('docker', ['ps', '--filter', 'name=supabase_db_', '--format', '{{.Names}}'], {
    cwd: root,
    encoding: 'utf8',
  });
  const container = lookup.stdout.trim().split(/\r?\n/).find(Boolean);
  if (!container) throw new Error('Local Supabase database container is not running');

  const copy = spawnSync('docker', ['cp', file, `${container}:/tmp/${file.split(/[\\/]/).pop()}`], {
    cwd: root,
    stdio: 'inherit',
  });
  if (copy.status !== 0) process.exit(copy.status ?? 1);

  const name = file.split(/[\\/]/).pop();
  const result = spawnSync('docker', ['exec', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-f', `/tmp/${name}`], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['--yes', SUPABASE_CLI, 'db', 'reset', '--local', '--yes']);
const tempRoot = mkdtempSync(join(tmpdir(), 'tasktrace-sql-'));
try {
  for (const file of ['initial_schema_smoke_test.sql', 'rls_and_rpc_test.sql', 'notifications_test.sql', 'full_integration_test.sql']) {
    const source = readFileSync(resolve(root, 'supabase', 'tests', file), 'utf8');
    const tempFile = join(tempRoot, file);
    writeFileSync(tempFile, source);
    runInLocalPostgres(tempFile);
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log('SQL suites passed. concurrency_test.sql remains a two-session manual harness.');
