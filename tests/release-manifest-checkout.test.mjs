import { expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import { manifest, maintenanceSql } from '../scripts/release-manifest.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const migrations = () => readdirSync('supabase/migrations').filter((name) => name.endsWith('.sql')).sort().map((name) => `supabase/migrations/${name}`);

it('release evidence matches exact checkout bytes and every hashed input has explicit LF checkout attributes', () => {
  const stored = JSON.parse(readFileSync('docs/release/manifest.json', 'utf8'));
  expect(stored).toEqual(manifest());
  expect(readFileSync('docs/release/prepare-maintenance.sql', 'utf8')).toBe(maintenanceSql());
  const files = [...migrations(), ...readdirSync('docs/release').filter((name) => /\.(?:sql|json)$/.test(name)).map((name) => `docs/release/${name}`)];
  const attrs = execFileSync('git', ['-c', 'core.autocrlf=true', 'check-attr', '-z', '--stdin', 'eol'], { input: `${files.join('\0')}\0`, encoding: 'utf8' }).split('\0');
  for (let i = 0; i < files.length; i++) {
    expect(attrs.slice(i * 3, i * 3 + 3)).toEqual([files[i], 'eol', 'lf']);
    expect(readFileSync(files[i], 'utf8')).not.toContain('\r\n');
  }
});

it('a canonical Git copy passes while a changed migration byte or CRLF conversion still fails closed', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'tasktrace-manifest-checkout-'));
  const sqlFiles = migrations();
  const files = ['scripts/release-manifest.mjs', ...['manifest.json', 'prepare-maintenance.sql', 'production-preconditions-2026-10-24.json', 'preflight.sql', 'postconditions.sql', 'fixture-differences.json', 'function-token-contract.json'].map((name) => `docs/release/${name}`), ...sqlFiles];
  try {
    const output = execFileSync('git', ['cat-file', '--batch'], { input: `${sqlFiles.map((file) => `HEAD:${file}`).join('\n')}\n`, maxBuffer: 20 * 1024 * 1024 });
    const canonical = new Map();
    let offset = 0;
    for (const file of sqlFiles) {
      const end = output.indexOf(10, offset), header = output.subarray(offset, end).toString('utf8');
      const match = header.match(/^[a-f0-9]{40} blob (\d+)$/);
      expect(match, `Git blob for ${file}`).not.toBeNull();
      const size = Number(match[1]);
      canonical.set(file, output.subarray(end + 1, end + 1 + size));
      offset = end + 1 + size + 1;
    }
    expect(offset).toBe(output.length);
    for (const file of files) {
      const bytes = canonical.get(file) ?? readFileSync(file);
      mkdirSync(dirname(resolve(root, file)), { recursive: true });
      writeFileSync(resolve(root, file), bytes);
    }
    const check = () => spawnSync(process.execPath, ['scripts/release-manifest.mjs', '--check'], { cwd: root, encoding: 'utf8', windowsHide: true });
    expect(check().status).toBe(0);
    const stored = JSON.parse(readFileSync(resolve(root, 'docs/release/manifest.json'), 'utf8'));
    const historical = `supabase/migrations/${stored.historicalMigrationDigests[0].version}_${stored.historicalMigrationDigests[0].name}.sql`;
    const file = resolve(root, historical), original = readFileSync(file);
    expect(digest(original)).toBe(stored.historicalMigrationDigests[0].sha256);
    for (const changed of [Buffer.concat([original, Buffer.from('\n-- changed bytes\n')]), Buffer.from(original.toString('utf8').replace(/\n/g, '\r\n')), Buffer.from(original.toString('utf8').replace('\n', '\r\n'))]) {
      writeFileSync(file, changed);
      const result = check();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Release manifest/hash drift');
    }
    writeFileSync(file, original);
    const forward = resolve(root, 'supabase/migrations', stored.steps[0].file);
    writeFileSync(forward, Buffer.concat([readFileSync(forward), Buffer.from('\n-- changed forward bytes\n')]));
    expect(check().status).not.toBe(0);
    writeFileSync(forward, canonical.get(`supabase/migrations/${stored.steps[0].file}`));
    const manifestFile=resolve(root,'docs/release/manifest.json'),manifestBytes=readFileSync(manifestFile);
    for(const mutate of [
      value=>{value.steps.reverse();},
      value=>{value.steps[0].sha256='0'.repeat(64);},
      value=>{value.steps[0].order=99;},
    ]){
      const changed=structuredClone(stored);mutate(changed);writeFileSync(manifestFile,JSON.stringify(changed));
      const result=check();expect(result.status).not.toBe(0);expect(result.stderr).toContain('Release manifest/hash drift');
    }
    for(const invalid of ['{}','{invalid-json']){writeFileSync(manifestFile,invalid);expect(check().status).not.toBe(0);}
    writeFileSync(manifestFile,manifestBytes);expect(check().status).toBe(0);
  } finally {
    const base = resolve(tmpdir()) + sep;
    if (!root.startsWith(base) || !root.slice(base.length).startsWith('tasktrace-manifest-checkout-')) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
