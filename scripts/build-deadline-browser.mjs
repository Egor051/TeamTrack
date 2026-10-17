// Reproducible browser fixture build. Never edits .env or contacts hosted data.
import { spawnSync } from 'node:child_process';
const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm', 'run', 'build:web'] : ['run', 'build:web'];
const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true,
  env: { ...process.env, EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:55539', EXPO_PUBLIC_SUPABASE_ANON_KEY: 'local-browser-fixture-key',
    EXPO_PUBLIC_OFFLINE_WRITE_ENABLED: 'true', EXPO_PUBLIC_OFFLINE_SYNC_ENABLED: 'true' } });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
