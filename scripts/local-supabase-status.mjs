import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const root = resolve(import.meta.dirname, '..');
const SUPABASE_CLI = 'supabase@2.116.0';

export function getLocalSupabaseStatus() {
  if (process.env.TASKTRACE_ISOLATED_CONFIG) {
    const status = JSON.parse(readFileSync(process.env.TASKTRACE_ISOLATED_CONFIG, 'utf8'));
    const db = new URL(status.DB_URL);
    if (status.kind !== 'tasktrace-isolated-security-test'
      || !/^\/teamtrack_audit_\d+$/.test(db.pathname)
      || [status.API_URL, status.DB_URL, status.MAILPIT_URL].some((raw) => new URL(raw).hostname !== '127.0.0.1'))
      throw new Error('An isolated loopback test stack is required');
    return status;
  }
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
