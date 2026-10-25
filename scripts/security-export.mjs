// One guarded path for CI, web builds and compatible rollback exports.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportInputSha256, verifyToolingConditions } from './security-tooling-conditions.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export function exportArguments(args) {
  const result = ['export'];
  let platforms = 0, output = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--clear' || arg === '--source-maps') result.push(arg);
    else if (arg === '--platform' && ['web', 'android', 'ios'].includes(args[index + 1])) {
      result.push(arg, args[++index]); platforms++;
    } else if (arg === '--output-dir' && args[index + 1] && !output) {
      result.push(arg, args[++index]); output = true;
    } else throw new Error('Unsupported unsigned export option: ' + arg);
  }
  if (!platforms || !output) throw new Error('Explicit platform and output directory required');
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = exportArguments(process.argv.slice(2));
  const environment = { ...process.env, EXPO_NO_DOTENV: '1' };
  verifyToolingConditions({ directory: root, environment });
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules/expo/bin/cli'), ...args],
    { cwd: root, env: environment, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (result.status === 0) {
    const out = resolve(root, args[args.indexOf('--output-dir') + 1]);
    const sha = bytes => createHash('sha256').update(bytes).digest('hex');
    const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(resolve(dir, e.name)) : [resolve(dir, e.name)]);
    writeFileSync(resolve(out, 'security-export.json'), JSON.stringify({ kind: 'isolated-unsigned-static-export',
      lockSha256: sha(readFileSync(resolve(root, 'package-lock.json'))), packageManifestSha256: sha(readFileSync(resolve(root, 'package.json'))),
      inputNormalization: 'runtime-export-inputs-lf-v1', inputsSha256: exportInputSha256(root),
      files: walk(out).filter(path => /\/_expo\/static\/js\/(?:web|android|ios)\//.test(path.replaceAll('\\', '/')))
        .map(path => ({ file: relative(out, path).replaceAll('\\', '/'), sha256: sha(readFileSync(path)) })),
    }, null, 2) + '\n');
  }
}
