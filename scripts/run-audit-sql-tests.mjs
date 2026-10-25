// Isolated local regression database. Never resets or migrates the app database.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyTemplateConcurrency } from './audit-template-concurrency.mjs';
import { localDbBridge } from './local-db-bridge.mjs';
import { verifyChecklistDeadlineIntegration } from './checklist-deadline-integration.mjs';
import { verifyDeadlineCron } from './checklist-deadline-cron.mjs';
import { securityDatabaseContainers } from './security-test-harness.mjs';
import { sqlTestSuites } from './sql-test-suites.mjs';
import { receiptTestPolicySql } from './receipt-test-policy.mjs';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '..');
const fresh = process.argv.includes('--fresh');
const options = new Set(['--fresh','--advisors','--generate-types','--cron']);
for (const arg of process.argv.slice(2)) if (arg.startsWith('--') && !options.has(arg)) throw new Error(`Unknown SQL option: ${arg}`);
const plan = sqlTestSuites(resolve(root, 'supabase/tests'), { fresh,
  requested: process.argv.slice(2).filter((arg) => !arg.startsWith('--')) });
function docker(args, input) {
  const result = spawnSync('docker', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `docker exited ${result.status}`);
  return result.stdout;
}
const {container,providerContainer} = securityDatabaseContainers();
const database = `teamtrack_audit_${process.pid}`;
const sql = (source, db = database) => docker(['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', db], `set search_path = public, extensions;\n${source}`);
const base = docker(['exec', providerContainer, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--schema-only', '--no-owner', '--no-privileges', '--schema=auth', '--schema=realtime'])
  .replace(/^CREATE TRIGGER[^\n]*EXECUTE FUNCTION (?:private|public)\.[^\n]*;\r?\n/gm, '')
  .replace(/^CREATE POLICY tasktrace_broadcast_read[^\n]*;\r?\n/gm, '');
sql(`create database ${database} owner postgres;`, 'postgres');
let bridge;
try {
  sql(base);
  sql('create schema extensions; create extension pgcrypto with schema extensions; create publication supabase_realtime; grant usage on schema public to postgres; grant create on schema public to postgres; grant usage on schema auth, realtime to authenticated, anon, postgres; grant execute on all functions in schema auth, realtime to authenticated, anon, postgres; grant all on all tables in schema auth,realtime to postgres; grant all on all sequences in schema auth,realtime to postgres;');
  const migrations = readdirSync(resolve(root, 'supabase/migrations')).filter((name) => name.endsWith('.sql')).sort();
  let upgrade = '';
  for (const name of migrations) {
    upgrade += `\n\\echo Migration ${name}\nset role postgres; set search_path = public, extensions;\n`;
    if (!fresh && name === '20260927181857_implement_backend_remediation.sql') {
      upgrade += readFileSync(resolve(root, 'supabase/tests/audit_upgrade_fixture.sql'), 'utf8') + '\n';
    }
    if (!fresh && name.endsWith('_audit_template_ordering.sql')) upgrade += readFileSync(resolve(root, 'supabase/tests/audit_template_upgrade_fixture.sql'), 'utf8') + '\n';
    if (!fresh && name.endsWith('_audit_followup_integrity_and_scaling.sql')) upgrade += readFileSync(resolve(root, 'supabase/tests/audit_followup_upgrade_fixture.sql'), 'utf8') + '\n';
    // Fixtures use RESET ROLE. Restore the migration owner after fixture work,
    // just as the real migration runner does for every migration.
    upgrade += 'set role postgres; set search_path=public,extensions;\n';
    upgrade += readFileSync(resolve(root, 'supabase/migrations', name), 'utf8') + '\n';
  }
  sql(upgrade);
  sql(receiptTestPolicySql);
  console.log(`PASS ${fresh ? 'FRESH' : 'UPGRADE'}: all migrations applied in isolation`);
  for (const name of plan.notApplicable) console.log(`NOT APPLICABLE on fresh DB (mandatory in upgrade run): ${name}`);
  console.log(`MANUAL ONLY: ${plan.manual}; automated equivalent required in test:backend:isolated`);
  for (const file of plan.suites) {
    sql(readFileSync(resolve(root, 'supabase/tests', file), 'utf8'));
    console.log(`PASS ${file}`);
  }
  bridge = localDbBridge(container);
  const { port } = bridge;
  if (process.argv.includes('--advisors')) {
    // Run the official, pinned advisor SQL via the already verified container
    // connection. The CLI's Docker Desktop connection can time out here.
    const lint = process.env.TASKTRACE_ADVISOR_SQL_FILE
      ? readFileSync(process.env.TASKTRACE_ADVISOR_SQL_FILE, 'utf8')
      : await fetch('https://raw.githubusercontent.com/supabase/splinter/fccca4b1c4d8b48b8ccd69bd6b30e84adcb92975/splinter.sql').then((r) => { if (!r.ok) throw new Error('Advisor SQL download failed'); return r.text(); });
    if (createHash('sha256').update(lint).digest('hex') !== 'd8d558baad3e03832e521c527907fa50a9a172fabd899dd0f5c2504a5a0e9349')
      throw new Error('Pinned advisor SQL checksum mismatch');
    const start = lint.indexOf('\n(\nwith foreign_keys');
    if (start < 0) throw new Error('Unexpected advisor SQL structure');
    const output = sql(`begin; select set_config('pgrst.db_schemas','public',true);\n${lint.slice(0, start)}\ncreate temporary table deadline_security_findings as ${lint.slice(start)};\nselect name, level, count(*) from pg_temp.deadline_security_findings where 'SECURITY'=any(categories) group by name,level order by name;\ndo $$begin if exists(select 1 from pg_temp.deadline_security_findings where level='ERROR' and 'SECURITY'=any(categories)) then raise exception 'Security advisor errors'; end if; end$$; rollback;`);
    console.log(output.trim());
    console.log('PASS official Supabase security advisor SQL: zero ERROR findings (isolated database)');
  }
  if (process.argv.includes('--generate-types')) {
    // Use the same generator image as the local Supabase CLI, directly inside
    // its network (Docker Desktop host-network loopback is not portable).
    const network = docker(['inspect', container, '--format', '{{.HostConfig.NetworkMode}}']).trim();
    const image = docker(['inspect', providerContainer.replace('supabase_db_', 'supabase_pg_meta_'), '--format', '{{.Config.Image}}']).trim();
    const generated = docker(['run', '--rm', '--network', network,
      '-e', `PG_META_DB_HOST=${container}`, '-e', `PG_META_DB_NAME=${database}`,
      '-e', 'PG_META_DB_USER=supabase_admin', '-e', 'PG_META_GENERATE_TYPES=typescript',
      '-e', 'PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS=public', '-e', 'PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=true', image]);
    writeFileSync(resolve(root, 'src/types/database.types.ts'), generated.trimEnd() + '\n');
    console.log('PASS generated database types from the migrated isolated database');
  }
  await verifyTemplateConcurrency(port, database);
  await verifyChecklistDeadlineIntegration(port, database, container, providerContainer);
  if (process.argv.includes('--cron')) await verifyDeadlineCron(container, base, upgrade);
} finally {
  bridge?.close();
  // Only the database created by this process can be removed.
  sql(`drop database ${database} with (force);`, 'postgres');
}
