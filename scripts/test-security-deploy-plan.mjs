// Rehearse a captured production lineage with the real CLI, only in a disposable DB.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, cpSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createSecurityDatabase, root, snapshotDiff, asUser } from './security-test-harness.mjs';
import { startSecurityApi } from './security-test-api.mjs';
import { restoreHostedSecurityFixture } from './security-hosted-fixture.mjs';
const [baselinePath, planPath, snapshotPath] = process.argv.slice(2);
if (!baselinePath || !planPath || !snapshotPath) throw Error('Expected captured history, offline plan and captured schema');
const history = JSON.parse(readFileSync(baselinePath, 'utf8'));
const plan = JSON.parse(readFileSync(resolve(planPath, 'manifest.json'), 'utf8'));
const hosted = JSON.parse(readFileSync(snapshotPath, 'utf8')).snapshot;
assert.equal(plan.production_applied, false); assert.equal(plan.baseline.length, history.length);
assert(plan.pending.length > 0); assert.equal(plan.pending.length, plan.required_pending_count);
const snapshotSql = readFileSync(resolve(root, 'supabase/tests/security_snapshot.sql'), 'utf8');
const evidence = process.env.TASKTRACE_SECURITY_EVIDENCE || resolve(root, '.expo/security-evidence');
mkdirSync(evidence, { recursive: true });
const snapshot = async env => (await env.db.query('set search_path=public,extensions;' + snapshotSql)).at(-1).rows[0].snapshot;
// Physical attribute numbers are not API field order. Per-schema defaults add
// grants to global defaults; a row granting only built-in owner rights adds
// nothing. Preserve global function defaults (including PUBLIC EXECUTE).
const logical = value => {
  const copy = structuredClone(value);
  copy.columns.forEach(row => { delete row.position; });
  copy.defaults = copy.defaults.filter(row => {
    if (row.schema === '*') return true;
    const ownerOnly = { f: 'X', r: 'arwdDxtm', S: 'rwU' }[row.kind];
    return row.acl !== null && row.acl !== '{' + row.owner + '=' + ownerOnly + '/' + row.owner + '}';
  });
  return copy;
};
let expected;
const canonical = await createSecurityDatabase({ beforeVersion: plan.pending[0].version });
try {
  await restoreHostedSecurityFixture(canonical, snapshotPath);
  assert.deepEqual(snapshotDiff(logical(await snapshot(canonical)), logical(hosted)), {});
  for (const file of plan.pending) canonical.sql('set role postgres; '+readFileSync(resolve(planPath,'supabase/migrations',file.file),'utf8'));
  expected = await snapshot(canonical);
} finally { await canonical.close(); }
const env = await createSecurityDatabase({ beforeVersion: plan.pending[0].version });
let api;
try {
  await restoreHostedSecurityFixture(env, snapshotPath);
  const baselineDiff = snapshotDiff(logical(await snapshot(env)), logical(hosted));
  writeFileSync(resolve(evidence, 'release-hosted-baseline-diff.json'), JSON.stringify(baselineDiff, null, 2));
  assert.deepEqual(baselineDiff, {}, 'Captured hosted schema differs from the locally reconstructed migration boundary');
  console.log('PASS exact current hosted schema reconstruction before pending migrations (schema-only, no hosted data)');
  const user = randomUUID();
  await env.db.query("insert into auth.users(id,email,raw_user_meta_data)values($1,'release-upgrade@test.local','{}')", [user]);
  const project = (await asUser(env.db, user, () => env.db.query("select public.create_project('Legacy before') id"))).rows[0].id;
  api = await startSecurityApi(env);
  const client = api.client(user);
  const value = async promise => { const result = await promise; if (result.error) throw result.error; return result.data; };
  const template = await value(client.rpc('create_task_template', { p_name: 'Legacy template' }));
  const item = await value(client.rpc('create_task_template_item', { p_template_id: template, p_title: 'Legacy item' }));
  await value(client.rpc('update_project', { p_project_id: project, p_name: 'Legacy before', p_description: '' }));
  assert.equal((await client.rpc('get_task_template_page')).error?.code, 'PGRST202');
  const rejected = await client.rpc('update_project', { p_project_id: project, p_name: 'Must not save', p_description: '', p_expected_name: 'Legacy before', p_expected_description: '' });
  assert.equal(rejected.error?.code, 'PGRST202');
  assert.equal((await env.db.query('select name from public.projects where id=$1', [project])).rows[0].name, 'Legacy before');
  console.log('PASS partial deployment: legacy client works; new page/CAS RPCs fail closed on old server without mutation');
  await env.db.query('create schema supabase_migrations authorization postgres;create table supabase_migrations.schema_migrations(version text primary key,statements text[],name text);alter table supabase_migrations.schema_migrations owner to postgres');
  for (const row of history) await env.db.query('insert into supabase_migrations.schema_migrations values($1,$2,$3)', [row.version, row.statements, row.name]);
  const uri = 'postgresql://postgres:postgres@127.0.0.1:' + env.port + '/' + env.database;
  const cli = (dry, directory = planPath) => new Promise((ok, no) => {
    const args = ['--offline', '--yes', 'supabase@2.116.0', '--workdir', resolve(directory), 'db', 'push', '--db-url', uri, ...(dry ? ['--dry-run'] : ['--yes'])];
    const child = spawn(process.platform === 'win32' ? process.env.ComSpec : 'npx', process.platform === 'win32' ? ['/d', '/s', '/c', 'npx', ...args] : args, { cwd: root, windowsHide: true });
    let output = ''; child.stdout.on('data', s => { output += s; }); child.stderr.on('data', s => { output += s; });
    child.once('error', no); child.once('exit', code => code === 0 ? ok(output) : no(Error('Isolated CLI failed: ' + output)));
  });
  const dry = await cli(true);
  for (const file of plan.pending) assert(dry.includes(file.file), 'CLI did not propose ' + file.file);
  assert.equal(dry.split(/\r?\n/).filter(line => /^\s*[•*]\s+\d{14}_/.test(line)).length, plan.pending.length);
  const failedPlan = resolve(evidence, 'failed-plan-' + process.pid);
  cpSync(resolve(planPath, 'supabase'), resolve(failedPlan, 'supabase'), { recursive: true, errorOnExist: true, force: false });
  appendFileSync(resolve(failedPlan,'supabase/migrations',plan.pending[0].file), '\nselect 1/0; -- isolated failure injection\n');
  const preFailure = await snapshot(env);
  await assert.rejects(() => cli(false, failedPlan), /division by zero/);
  assert.equal((await env.db.query('select count(*)::int n from supabase_migrations.schema_migrations')).rows[0].n, history.length);
  assert.deepEqual(snapshotDiff(await snapshot(env), preFailure), {}, 'failed migration partially changed application schema');
  console.log('PASS failed deployment: injected SQL error rolls back DDL/history, legacy API remains usable, corrected plan can resume');
  await cli(false);
  assert.equal((await env.db.query('select count(*)::int n from supabase_migrations.schema_migrations')).rows[0].n, history.length + plan.pending.length);
  assert.match(await cli(true), /up to date/i);
  let refreshed = false;
  for (let n = 0; n < 30; n++) {
    const page = await client.rpc('get_task_template_page');
    if (!page.error && page.data.rows.some(row => row.id === template)) { refreshed = true; break; }
    await new Promise(done => setTimeout(done, 200));
  }
  assert(refreshed, 'Running PostgREST did not adopt new RPCs after migration; schema reload missing');
  await value(client.rpc('update_project', { p_project_id: project, p_name: 'Legacy after', p_description: '' }));
  await value(client.rpc('update_task_template', { p_template_id: template, p_name: 'Legacy template after', p_description: '' }));
  await value(client.rpc('update_task_template_item', { p_item_id: item, p_title: 'Legacy item after', p_description: '' }));
  await value(client.rpc('update_project', { p_project_id: project, p_name: 'CAS saved', p_description: '', p_expected_name: 'Legacy after', p_expected_description: '' }));
  assert.equal((await client.rpc('update_project', { p_project_id: project, p_name: 'Lost', p_description: '', p_expected_name: 'Legacy after', p_expected_description: '' })).error?.code, 'PT409');
  const diff = snapshotDiff(await snapshot(env), expected);
  writeFileSync(resolve(evidence, 'release-upgrade-schema-diff.json'), JSON.stringify(diff, null, 2));
  assert.deepEqual(diff, {});
  writeFileSync(resolve(evidence, 'release-deployment-rehearsal.json'), JSON.stringify({ production_applied: false, baseline: history.length, pending: plan.pending.length, final_history: history.length + plan.pending.length,
    exact_hosted_boundary: true, failed_migration_rolled_back: true, new_client_old_server_fails_closed: true, old_client_new_server_compatible: true, running_api_schema_reloaded: true, final_schema_matches_canonical: true }, null, 2));
  console.log('PASS real CLI rehearsal: ' + history.length + '+' + plan.pending.length + ', second dry-run empty, running API reload, legacy signatures, CAS, canonical schema');
} finally { api?.close(); await env.close(); }
