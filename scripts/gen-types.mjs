// TaskTrace — database type generation
//
// Regenerates `src/types/database.types.ts` from a database that has the
// TaskTrace migrations applied. The canonical tool is the Supabase CLI:
//
//   supabase gen types typescript --schema public [--db-url | --project-id]
//
// Generated types are the single source of truth for the typed Supabase
// client in src/lib/supabase/client.ts. Do not hand-edit the generated file.
//
// Environment (see `.env`):
//   SUPABASE_DB_URL        — direct Postgres connection string (default path)
//   SUPABASE_PROJECT_ID    — hosted project ref (requires `supabase link`)
//
// Examples:
//   node scripts/gen-types.mjs                        # uses SUPABASE_DB_URL
//   node scripts/gen-types.mjs --project-id           # uses linked project
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = resolve(root, 'src/types/database.types.ts');
const SUPABASE_CLI = 'supabase@2.116.0';

// Minimal .env loader (no dotenv dependency).
function loadEnvFile() {
  const envPath = resolve(root, '.env');
  if (!existsSync(envPath)) {
    return;
  }
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function run(...args) {
  const commandArgs = ['--yes', SUPABASE_CLI, 'gen', 'types', 'typescript', ...args];
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const executable = process.platform === 'win32'
    ? (process.env.ComSpec || 'cmd.exe')
    : npx;
  const executableArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', npx, ...commandArgs]
    : commandArgs;
  return execFileSync(executable, executableArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function main() {
  loadEnvFile();

  const useProjectId = process.argv.includes('--project-id');
  const projectId = process.env.SUPABASE_PROJECT_ID;
  const dbUrl = process.env.SUPABASE_DB_URL;

  let stdout;
  if (useProjectId) {
    if (!projectId || projectId === 'YOUR_PROJECT_REF') {
      throw new Error('SUPABASE_PROJECT_ID is not set. Run `supabase link --project-ref <ref>` and set it in .env.');
    }
    stdout = run('--schema', 'public', '--project-id', projectId);
  } else {
    if (!dbUrl || !dbUrl.includes('postgres')) {
      throw new Error('SUPABASE_DB_URL is not set (see .env.example).');
    }
    stdout = run('--schema', 'public', '--db-url', dbUrl);
  }

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, stdout);
  console.log(`✔ Wrote ${outFile} (${stdout.split('\n').length} lines)`);
}

try {
  main();
} catch (error) {
  console.error(`✖ Failed to generate types: ${error.message}`);
  process.exit(1);
}
