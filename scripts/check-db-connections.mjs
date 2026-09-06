import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertNoPublicDatabaseUrl, classifyDatabaseUrl } from './db-url-policy.mjs';

const root = resolve(import.meta.dirname, '..');
const errors = [];

function inspectVariable(variableName, value, source) {
  if (typeof value !== 'string') return;
  try { assertNoPublicDatabaseUrl(variableName, value); } catch (error) { errors.push(`${source}: ${error.message}`); }
  if (!/(DB_URL|DATABASE_URL|POSTGRES_URL|POSTGRES_PRISMA_URL)$/i.test(variableName) || !value || value.startsWith('YOUR_')) return;
  const classification = classifyDatabaseUrl(value);
  if (classification.kind === 'hosted-direct') errors.push(`${source}: ${variableName} uses a hosted direct endpoint; use a Supabase pooler URL.`);
  if (classification.kind === 'invalid') errors.push(`${source}: ${variableName} is not a valid PostgreSQL URL.`);
}

function inspectEnvFile(name) {
  const file = resolve(root, name);
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    const variableName = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^("|')|("|')$/g, '');
    inspectVariable(variableName, value, name);
  }
}

inspectEnvFile('.env');
inspectEnvFile('.env.example');
for (const [variableName, value] of Object.entries(process.env)) inspectVariable(variableName, value, 'process.env');

const trackedFiles = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
for (const relative of trackedFiles) {
  if (/package-lock\.json$|\.(png|jpg|jpeg|gif|ico|woff2?)$/i.test(relative)) continue;
  let contents;
  try { contents = readFileSync(resolve(root, relative), 'utf8'); } catch { continue; }
  if (/EXPO_PUBLIC_[A-Z0-9_]*(?:DB|DATABASE|POSTGRES|CONNECTION)[A-Z0-9_]*\s*=/i.test(contents)) errors.push(`${relative}: public environment variables must not contain database connection settings.`);
  if (/db\.[a-z0-9]{20}\.supabase\.co(?::5432)?/i.test(contents)) errors.push(`${relative}: hosted direct Supabase endpoint found in tracked source/configuration.`);
}

if (errors.length) {
  console.error(errors.map((error) => `x ${error}`).join('\n'));
  process.exit(1);
}
console.log('Database connection policy passed: no public DB URLs or hosted direct endpoints found.');
