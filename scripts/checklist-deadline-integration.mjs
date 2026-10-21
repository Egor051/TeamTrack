import { fixtureCas } from './fixture-cas.mjs';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { PostgrestClient } from '@supabase/postgrest-js';
import { verifyDeadlineBrowser } from './checklist-deadline-browser.mjs';
import { verifyStageMembershipIntegration } from './stage-membership-integration.mjs';

export async function verifyChecklistDeadlineIntegration(port, database, container, providerContainer=container) {
  if (!/^teamtrack_audit_\d+$/.test(database)) throw new Error('Isolated database required');
  const db = new pg.Client({ host: '127.0.0.1', port, database, user: 'supabase_admin', password: 'postgres' });
  const docker = (args) => {
    const r = spawnSync('docker', args, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout); return r.stdout.trim();
  };
  const network = docker(['inspect', container, '--format', '{{.HostConfig.NetworkMode}}']);
  const image = docker(['inspect', providerContainer.replace('supabase_db_', 'supabase_rest_'), '--format', '{{.Config.Image}}']);
  const name = `tasktrace-deadline-api-${process.pid}`;
  const secret = randomUUID() + randomUUID();
  const token = (sub) => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ role: sub ? 'authenticated' : 'anon', sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    return `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
  };
  const data = async (promise) => { const r = await promise; if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
  try {
    await db.connect();
    docker(['run', '--rm', '-d', '--name', name, '--network', network, '-p', '127.0.0.1::3000',
      '-e', `PGRST_DB_URI=postgresql://supabase_admin:postgres@${container}:5432/${database}`,
      '-e', 'PGRST_DB_SCHEMAS=public', '-e', 'PGRST_DB_ANON_ROLE=anon', '-e', `PGRST_JWT_SECRET=${secret}`, image]);
    const apiPort = Number(docker(['port', name, '3000/tcp']).match(/:(\d+)\s*$/m)?.[1]);
    const api = `http://127.0.0.1:${apiPort}`;
    for (let n = 0; n < 40; n++) {
      try { if ((await fetch(api)).ok) break; } catch { /* startup */ }
      if (n === 39) throw new Error('Isolated PostgREST startup timed out');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const ids = Array.from({ length: 4 }, () => randomUUID());
    for (const id of ids) await db.query("insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,'{}')", [id, `${id}@deadline.test`]);
    const [owner, member, viewer, outsider] = ids.map((id) => new PostgrestClient(api, { headers: { Authorization: `Bearer ${token(id)}` } }));
    const project = await data(owner.rpc('create_project', { p_name: 'API deadline project' }));
    const task = await data(owner.rpc('create_task', { p_project_id: project, p_title: 'API stage' }));
    const item = await data(owner.rpc('create_task_item', { p_task_id: task, p_title: 'API checklist' }));
    await data(owner.rpc('add_project_member', { p_project_id: project, p_user_id: ids[1], p_role: 'member' }));
    await data(owner.rpc('add_project_member', { p_project_id: project, p_user_id: ids[2], p_role: 'viewer' }));
    for (const [name, args] of [['change_member_role', { p_project_id: project, p_user_id: ids[0], p_new_role: 'member' }],
      ['set_task_member_override', { p_task_id: task, p_user_id: ids[0], p_role: 'viewer' }], ['clear_task_member_override', { p_task_id: task, p_user_id: ids[0] }]]) {
      assert.equal((await fixtureCas(owner,name,args)).error?.code, '42501', `${name} allowed own-role edit`);
    }
    assert.deepEqual(await data(outsider.rpc('notification_filter_options')), { projects: [], tasks: [] });
    console.log('PASS roles/filter Data API: own-role RPC edits denied; notification facets cannot reveal another recipient');
    const due = new Date(Date.now() + 86_400_000).toISOString();
    await data(owner.rpc('set_task_item_deadline', { p_task_item_id: item, p_deadline_at: due, p_expected_version: 1 }));
    const seen = await data(member.from('checklist_overview').select('*').eq('id', item).single());
    assert.equal(Date.parse(seen.deadline_at), Date.parse(due));
    assert.equal((await data(outsider.from('checklist_overview').select('*').eq('id', item))).length, 0);
    assert.equal((await viewer.rpc('set_task_item_deadline', { p_task_item_id: item, p_expected_version: 2 })).error?.code, '42501');
    console.log('PASS deadline Data API: real RPC shape, absolute time, inherited member access, viewer/outsider isolation');

    const results = await Promise.all([owner, member].map((client, index) => client.rpc('set_task_item_deadline', {
      p_task_item_id: item, p_expected_version: 2, p_deadline_at: new Date(Date.now() + (index + 2) * 86_400_000).toISOString(),
    })));
    assert.equal(results.filter((r) => !r.error).length, 1);
    assert.equal(results.filter((r) => r.error?.code === 'PT409').length, 1);
    const current = await data(owner.from('task_items').select('*').eq('id', item).single());
    const conflict = await data(member.rpc('apply_task_item_percentage_operation_v2', {
      p_operation_id: randomUUID(), p_task_item_id: item, p_expected_version: 2, p_percentage: 100,
    }));
    assert.equal(conflict.status, 'conflict'); assert.equal(conflict.item.deadline_at, current.deadline_at);
    console.log('PASS deadline concurrency: exactly one competing save wins; stale offline progress cannot overwrite the server snapshot');

    await data(owner.rpc('set_task_item_deadline', { p_task_item_id: item, p_expected_version: current.sync_version, p_deadline_at: new Date(Date.now() + 3_600_000).toISOString() }));
    const messages = await db.query("select distinct topic from realtime.messages where payload->>'table'='task_items' and topic=any($1::text[])", [ids.slice(0, 3).map((id) => `user:${id}`)]);
    assert.equal(messages.rows.length, 3);
    console.log('PASS Broadcast fanout: checklist invalidation emitted to every authorized member, including unassigned users');

    await db.query('alter table public.task_items disable trigger trg_task_item_deadline_changed');
    await db.query("update public.task_items set deadline_at=now()-interval '1 second' where id=$1", [item]);
    await db.query('alter table public.task_items enable trigger trg_task_item_deadline_changed');
    await db.query("update private.checklist_deadline_state set state='urgent',next_transition_at=now()-interval '1 second' where item_id=$1", [item]);
    const worker = new pg.Client({ host: '127.0.0.1', port, database, user: 'supabase_admin', password: 'postgres' });
    try {
      await worker.connect();
      await worker.query('begin');
      await worker.query('select id from public.projects where id=$1 for update', [project]);
      assert.equal((await db.query('select private.process_checklist_deadlines() n')).rows[0].n, 0);
      await worker.query('rollback');
      await Promise.all([db.query('select private.process_checklist_deadlines()'), worker.query('select private.process_checklist_deadlines()')]);
    } finally { await worker.end(); }
    await db.query('select private.process_checklist_deadlines()');
    const notices = await db.query("select count(*)::int n from public.notifications where data->>'item_id'=$1 and data->>'deadline_event'='overdue'", [item]);
    assert.equal(notices.rows[0].n, 3);
    await data(fixtureCas(member, 'set_task_item_percentage', { p_task_item_id: item, p_percentage: 100 }));
    assert.equal((await data(owner.from('tasks').select('status').eq('id', task).single())).status, 'completed');
    await data(fixtureCas(member, 'set_task_item_percentage', { p_task_item_id: item, p_percentage: 0 }));
    assert.equal((await data(owner.from('tasks').select('status').eq('id', task).single())).status, 'not_started');
    const latest = await data(owner.from('task_items').select('sync_version').eq('id', item).single());
    await data(owner.rpc('set_task_item_deadline', { p_task_item_id: item, p_expected_version: latest.sync_version }));
    assert.equal((await data(owner.from('checklist_overview').select('deadline_at').eq('id', item).single())).deadline_at, null);
    console.log('PASS server worker concurrency: notifications without an app, retry deduplication, completion/reopening, deadline removal');
    await verifyStageMembershipIntegration({ api, db, owner, token, project, task, item });
    if (process.argv.includes('--browser')) await verifyDeadlineBrowser({ api, db, owner, ids, token, project, task, item });
  } finally {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' }); await db.end().catch(() => undefined);
  }
}
