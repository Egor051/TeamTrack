// Only the local stack is allowed, including the optional legacy reproduction.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';

const local = getLocalSupabaseStatus();
for (const raw of [local.API_URL, local.DB_URL]) {
  if (new URL(raw).hostname !== '127.0.0.1') throw new Error('Local Supabase required');
}
const db = new pg.Client({ connectionString: local.DB_URL, application_name: 'tasktrace-bootstrap-regression' });
const authOptions = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: authOptions });
const user = createClient(local.API_URL, local.ANON_KEY, { auth: authOptions });
const counts = { manifest: 0, page: 0, conflict: 0 };
const report = { legacy: null, stable: null, mutation: null, counts };
let id, project, task, item, token, savedDefinition;
const check = (ok, message) => { if (!ok) throw new Error(message); };
async function value(p) { const { data, error } = await p; if (error) throw error; return data; }
async function rpc(name, args, timeout = 5000) {
  if (name.endsWith('manifest')) counts.manifest++; else counts.page++;
  const response = await fetch(`${local.API_URL}/rest/v1/rpc/${name}`, { method: 'POST',
    headers: { apikey: local.ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(timeout) });
  const data = await response.json(); if (data.code === 'PT409') counts.conflict++;
  return { status: response.status, data };
}
const manifest = async (snapshot) => {
  const r = await rpc('get_offline_account_manifest', { p_scheme: 'extended', ...(snapshot ? { p_snapshot_at: snapshot } : {}) });
  check(r.status === 200, `Manifest failed: ${r.data.code}`); return r.data;
};
const page = (m, dataset, offset = 0) => rpc('get_offline_account_page', {
  p_dataset: dataset, p_revision: m.datasets[dataset].revision, p_snapshot_at: m.snapshot_at, p_offset: offset, p_limit: 500,
});
try {
  await db.connect();
  const email = `bootstrap-regression-${Date.now()}@test.local`, password = 'BootstrapRegression#123';
  id = (await value(admin.auth.admin.createUser({ email, password, email_confirm: true }))).user.id;
  token = (await value(user.auth.signInWithPassword({ email, password }))).session.access_token;
  project = await value(user.rpc('create_project', { p_name: 'Bootstrap regression', p_description: '' }));
  task = await value(user.rpc('create_task', { p_project_id: project, p_title: 'Stage', p_description: '' }));
  item = await value(user.rpc('create_task_item', { p_task_id: task, p_title: 'Item' }));

  if (process.argv.includes('--reproduce-legacy')) {
    // Restore only the local legacy page body temporarily, then restore the
    // exact current function even if the aborted HTTP request keeps retrying.
    const signature = 'public.get_offline_account_page(text,text,integer,integer)';
    savedDefinition = (await db.query('select pg_get_functiondef($1::regprocedure) as definition', [signature])).rows[0].definition;
    const source = readFileSync(new URL('../supabase/migrations/20261001162836_account_offline_bootstrap.sql', import.meta.url), 'utf8');
    const legacy = source.match(/create or replace function public\.get_offline_account_page[\s\S]*?end \$\$;/)?.[0];
    check(legacy, 'Legacy page definition missing');
    const activeBefore = (await db.query("select pid from pg_stat_activity where application_name like 'PostgREST%' and state='active' and query like '%get_offline_account_page%'")).rows.map((r) => r.pid);
    await db.query(legacy); await db.query("notify pgrst, 'reload schema'"); await delay(500);
    const since = new Date().toISOString();
    const response = rpc('get_offline_account_page', { p_dataset: 'items', p_revision: 'stale', p_offset: 0, p_limit: 500 }, 750).catch((e) => ({ aborted: e.name }));
    await delay(1000);
    const loops = (await db.query("select pid,backend_start,application_name,xact_start from pg_stat_activity where usename='authenticator' and application_name like 'PostgREST%' and state='active' and query like '%get_offline_account_page%' and query_start >= $1::timestamptz and not (pid = any($2::int[]))", [since, activeBefore])).rows;
    for (const loop of loops) await db.query('select pg_terminate_backend(pid) from pg_stat_activity where pid=$1 and backend_start=$2 and usename=\'authenticator\' and query like \'%get_offline_account_page%\'', [loop.pid, loop.backend_start]);
    const lookup = spawnSync('docker', ['ps', '--filter', 'name=supabase_db_', '--format', '{{.Names}}'], { encoding: 'utf8' });
    const container = lookup.stdout.trim().split(/\r?\n/)[0];
    const logs = spawnSync('docker', ['logs', '--since', since, container], { encoding: 'utf8' });
    const errors = `${logs.stdout}\n${logs.stderr}`.split(/\r?\n/).filter((line) => line.includes('ERROR:') && line.includes('offline snapshot changed')).length;
    const http = await response;
    report.legacy = { http_requests: 1, dataset: 'items', offset: 0, expected_revision: 'stale',
      database_errors: errors, lingering_after_http_abort: loops.length, application: loops[0]?.application_name, http };
    console.log('Local legacy reproduction:', JSON.stringify(report.legacy));
    check(errors > 1 && loops.length === 1, 'Legacy server retry loop was not reproduced');
    await db.query(savedDefinition); savedDefinition = null; await db.query("notify pgrst, 'reload schema'"); await delay(500);
  }

  const snapshot = (await db.query("select (clock_timestamp()-interval '2 seconds')::text as stamp")).rows[0].stamp;
  const audit = await db.query(`insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,created_at)
    values ($1,$2,'updated','task_item',$3,$4::timestamptz-interval '90 days'+interval '1 microsecond'),
           ($1,$2,'updated','task_item',$3,$4::timestamptz+interval '1 second') returning id`, [project,id,item,snapshot]);
  const m = await manifest(snapshot); let verified = 0;
  for (let round = 0; round < 10; round++) {
    const next = await manifest(m.snapshot_at);
    check(next.day_start === m.day_start && next.history_start === m.history_start, 'Snapshot windows drifted');
    for (const dataset of Object.keys(m.datasets)) {
      check(next.datasets[dataset].revision === m.datasets[dataset].revision, `Manifest drift: ${dataset}`);
      const p = await page(m, dataset);
      check(p.status === 200 && p.data.revision === m.datasets[dataset].revision, `Page drift: ${dataset} ${p.data.code}`);
      if (dataset === 'history') {
        check(p.data.rows.some((r) => String(r.id) === String(audit.rows[0].id)), 'Fixed history lower boundary row disappeared');
        check(!p.data.rows.some((r) => String(r.id) === String(audit.rows[1].id)), 'History upper boundary moved');
      }
      if (dataset === 'daily_audit') check(!p.data.rows.some((r) => String(r.id) === String(audit.rows[1].id)), 'Daily upper boundary moved');
      verified++;
    }
  }
  report.stable = { datasets: 15, rounds: 10, separate_http_pages: verified, snapshot_at: m.snapshot_at };
  console.log('PASS stable revisions across separate HTTP transactions:', JSON.stringify(report.stable));
  await value(user.rpc('set_task_item_percentage', { p_task_item_id: item, p_percentage: 67 }));
  const conflict = await page(m, 'items');
  check(conflict.status === 409 && conflict.data.code === 'PT409', 'Mutation did not return one HTTP conflict');
  const details = JSON.parse(conflict.data.details);
  check(details.dataset === 'items' && details.offset === 0 && details.expected_revision === m.datasets.items.revision
    && details.actual_revision !== details.expected_revision, 'Conflict diagnostics incomplete');
  const fresh = await manifest(); const recovered = await page(fresh, 'items');
  check(recovered.status === 200 && recovered.data.rows.some((r) => r.id === item && r.percentage === 67), 'Fresh snapshot did not recover');
  report.mutation = { status: conflict.status, code: conflict.data.code, ...details, recovery_status: recovered.status };
  console.log('PASS controlled mutation and recovery:', JSON.stringify(report.mutation));
  writeFileSync(new URL('../.expo/bootstrap-http-regression.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log('Bootstrap HTTP integration PASS:', JSON.stringify(counts));
} finally {
  if (savedDefinition) { await db.query(savedDefinition); await db.query("notify pgrst, 'reload schema'"); }
  if (project) {
    await value(user.rpc('archive_project', { p_project_id: project })).catch(() => undefined);
    await value(user.rpc('hard_delete_project', { p_project_id: project })).catch(() => undefined);
  }
  await user.auth.signOut(); await Promise.all([user.removeAllChannels(), admin.removeAllChannels()]);
  await db.end();
}
