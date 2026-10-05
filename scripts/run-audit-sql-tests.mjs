// Isolated local regression database. Never resets or migrates the app database.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyTemplateConcurrency } from './audit-template-concurrency.mjs';

const root = resolve(import.meta.dirname, '..');
function docker(args, input) {
  const result = spawnSync('docker', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `docker exited ${result.status}`);
  return result.stdout;
}
const containers = docker(['ps', '--filter', 'name=supabase_db_', '--format', '{{.Names}}']).trim().split(/\r?\n/).filter(Boolean);
if (containers.length !== 1) throw new Error('Expected exactly one already running local Supabase database');
const container = containers[0];
const database = `teamtrack_audit_${process.pid}`;
const sql = (source, db = database) => docker(['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'supabase_admin', '-d', db], `set search_path = public, extensions;\n${source}`);
const base = docker(['exec', container, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--schema-only', '--no-owner', '--no-privileges', '--schema=auth', '--schema=realtime'])
  .replace(/^CREATE TRIGGER[^\n]*EXECUTE FUNCTION (?:private|public)\.[^\n]*;\r?\n/gm, '')
  .replace(/^CREATE POLICY tasktrace_broadcast_read[^\n]*;\r?\n/gm, '');
sql(`create database ${database};`, 'postgres');
try {
  sql(base);
  sql('create schema extensions; create publication supabase_realtime; grant usage on schema auth, realtime to authenticated, anon; grant execute on all functions in schema auth to authenticated, anon;');
  const migrations = readdirSync(resolve(root, 'supabase/migrations')).filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    if (name === '20260927181857_implement_backend_remediation.sql') {
      sql(readFileSync(resolve(root, 'supabase/tests/audit_upgrade_fixture.sql'), 'utf8'));
    }
    if (name.endsWith('_audit_template_ordering.sql')) sql(readFileSync(resolve(root, 'supabase/tests/audit_template_upgrade_fixture.sql'), 'utf8'));
    try { sql(readFileSync(resolve(root, 'supabase/migrations', name), 'utf8')); }
    catch (error) { throw new Error(`Migration ${name}: ${error.message}\n${sql("select policyname, roles, cmd, qual from pg_policies where schemaname='public' and tablename='notifications';")}`, { cause: error }); }
  }
  console.log('PASS UPGRADE: all migrations applied to legacy valid data in an isolated database');
  const suites = process.argv.slice(2);
  for (const file of suites.length ? suites : ['audit_upgrade_test.sql', 'audit_template_ordering_test.sql', 'initial_schema_smoke_test.sql', 'stage_visibility_test.sql', 'rls_and_rpc_test.sql', 'notifications_test.sql', 'full_integration_test.sql', 'hard_delete_history_test.sql', 'task_enhancements_test.sql', 'offline_operation_receipts_test.sql', 'offline_pull_conflicts_test.sql', 'offline_phase6_runtime_retention_test.sql', 'account_offline_bootstrap_test.sql']) {
    sql(readFileSync(resolve(root, 'supabase/tests', file), 'utf8'));
    console.log(`PASS ${file}`);
  }
  const forwarded = docker(['port', container, '5432/tcp']);
  const port = Number(forwarded.match(/:(\d+)\s*$/m)?.[1]);
  await verifyTemplateConcurrency(port, database);
} finally {
  // Only the database created by this process can be removed.
  sql(`drop database ${database} with (force);`, 'postgres');
}
