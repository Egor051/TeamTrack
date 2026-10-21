import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { packageRunner } from '../scripts/package-runner.mjs';

it('BUG-10 passes PostgreSQL URLs through Node argv without a command shell', () => {
  const url = 'postgresql://fixture:p%25%26%22@localhost/db?sslmode=require&application_name=(test)%value';
  const invocation = packageRunner(['--db-url', url], { platform: 'win32', node: process.execPath, npm: '/npm/bin/npm-cli.js', path: '', exists: () => true });
  expect(invocation.command).toBe(process.execPath);
  expect(invocation.args.slice(1)).toEqual(['--db-url', url]);
  const actual = execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...invocation.args.slice(1)], { encoding: 'utf8', windowsHide: true });
  expect(JSON.parse(actual)).toEqual(['--db-url', url]);
});
it('fails explicitly when the Windows JS entry point is unavailable', () => {
  expect(() => packageRunner([], { platform: 'win32', path: '', exists: () => false })).toThrow('Cannot locate');
  expect(packageRunner(['a&b'], { platform: 'linux' })).toEqual({ command: 'npx', args: ['a&b'] });
});
