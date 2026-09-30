// Build only against the local Supabase stack. Does not change .env or hosted state.
import { spawnSync } from 'node:child_process';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';

const local = getLocalSupabaseStatus();
const url = new URL(local.API_URL);
if (url.hostname !== '127.0.0.1' || url.port !== '55431') throw new Error('Local Supabase required');
const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', 'run', 'build:web'] : ['run', 'build:web'];
const result = spawnSync(command, args, {
  cwd: new URL('..', import.meta.url), stdio: 'inherit',
  env: { ...process.env, EXPO_PUBLIC_SUPABASE_URL: local.API_URL,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: local.ANON_KEY,
    EXPO_PUBLIC_OFFLINE_WRITE_ENABLED: 'true', EXPO_PUBLIC_OFFLINE_SYNC_ENABLED: 'true' },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
