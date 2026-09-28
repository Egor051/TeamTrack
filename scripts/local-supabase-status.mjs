import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const SUPABASE_CLI = 'supabase@2.116.0';

export function getLocalSupabaseStatus() {
  const npxArgs = ['--yes', SUPABASE_CLI, 'status', '--output', 'json'];
  const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npx';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npx', ...npxArgs]
    : npxArgs;
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'Unable to read local Supabase status');
  const status = JSON.parse(result.stdout);
  for (const key of ['API_URL', 'DB_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY']) {
    if (!status[key]) throw new Error(`Local Supabase status is missing ${key}`);
  }
  return status;
}
