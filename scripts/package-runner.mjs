import { existsSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';

// Execute npm's JS entry point with Node on Windows. A .cmd shim would feed
// URLs containing &, %, quotes or parentheses through cmd.exe again.
export function packageRunner(args, { platform = process.platform, node = process.execPath,
  npm = process.env.npm_execpath, path = process.env.PATH || '', exists = existsSync } = {}) {
  if (platform !== 'win32') return { command: 'npx', args };
  const candidates = [npm && resolve(dirname(npm), 'npx-cli.js'),
    resolve(dirname(node), 'node_modules/npm/bin/npx-cli.js'),
    ...path.split(delimiter).filter(Boolean).map(directory => resolve(directory, 'node_modules/npm/bin/npx-cli.js'))].filter(Boolean);
  const script = candidates.find(candidate => exists(candidate));
  if (!script) throw new Error('Cannot locate npm/bin/npx-cli.js. Run with a supported Node/npm installation.');
  return { command: node, args: [script, ...args] };
}
