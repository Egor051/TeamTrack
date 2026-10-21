// Disposable PostgreSQL + real PostgREST; never uses application credentials.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSecurityDatabase } from './security-test-harness.mjs';
import { startSecurityApi } from './security-test-api.mjs';
const env = await createSecurityDatabase(); let api;
const value = async query => { const result = await query; if (result.error) throw result.error; return result.data; };
try {
  api = await startSecurityApi(env);
  const owner = randomUUID(), member = randomUUID(), outsider = randomUUID();
  for (const id of [owner, member, outsider]) await env.db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)', [id, id + '@followup.test', { display_name: 'Followup fixture' }]);
  const client = api.client(owner), reader = api.client(member), stranger = api.client(outsider);
  const project = await value(client.rpc('create_project', { p_name: 'Followup HTTP' }));
  await value(client.rpc('add_project_member', { p_project_id: project, p_user_id: member, p_role: 'member' }));
  const task = await value(client.rpc('create_task', { p_project_id: project, p_title: 'Snapshot 501' }));
  await env.db.query(`insert into public.task_items(task_id,title,position) select $1,'Item '||n,n from generate_series(1,501) n`, [task]);
  const first = await value(reader.rpc('get_task_item_snapshot_page', { p_task_id: task, p_mode: 'active', p_limit: 500 }));
  assert.equal(first.rows.length, 500); assert.equal(first.total, 501);
  await value(client.rpc('archive_task_item', { p_task_item_id: first.rows[0].id }));
  assert.equal((await reader.rpc('get_task_item_snapshot_page', { p_task_id: task, p_mode: 'active', p_offset: 500, p_revision: first.revision })).error?.code, 'PT409');
  const fresh = await value(reader.rpc('get_task_item_snapshot_page', { p_task_id: task, p_mode: 'active' }));
  assert.equal(fresh.rows.length, 500); assert.equal(fresh.rows.at(-1).title, 'Item 501');
  assert.equal((await stranger.rpc('get_task_item_snapshot_page', { p_task_id: task })).error?.code, '42501');
  console.log('PASS BUG-02: real 501-item snapshot rejects shifted offset and retains the unchanged final item');

  const item = fresh.rows[0];
  await value(reader.rpc('set_task_item_comment', { p_task_item_id: item.id, p_comment: 'Remote', p_expected_version: item.sync_version }));
  assert.equal((await reader.rpc('set_task_item_comment', { p_task_item_id: item.id, p_comment: 'Stale', p_expected_version: item.sync_version })).error?.code, 'PT409');
  const operation = randomUUID(), args = { p_project_id: project, p_title: 'One HTTP mutation' };
  const [one, two] = await Promise.all([value(client.rpc('execute_client_mutation', { p_operation_id: operation, p_name: 'create_task', p_args: args })), value(client.rpc('execute_client_mutation', { p_operation_id: operation, p_name: 'create_task', p_args: args }))]);
  assert.equal(one, two);
  assert.equal((await env.db.query('select count(*)::int n from public.tasks where id=$1', [one])).rows[0].n, 1);
  assert.ok((await stranger.rpc('execute_client_mutation', { p_operation_id: randomUUID(), p_name: 'create_task', p_args: args })).error);
  console.log('PASS BUG-01/05: PostgREST CAS and concurrent receipt replay preserve data and authorization');

  const template = await value(client.rpc('create_task_template', { p_name: 'Large followup template' }));
  await env.db.query(`insert into public.task_template_items(template_id,title,description,position) select $1,'Template '||n,'Instructions '||n,n from generate_series(1,1001) n`, [template]);
  let offset = 0, revision, after, all = [];
  do {
    const page = await value(client.rpc('get_task_template_page_v2', { p_template_id: template, p_offset: offset, p_limit: 500, p_revision: revision, p_after: after }));
    revision = page.revision; after = page.next; all.push(...page.rows); offset = all.length;
    assert.equal(page.total, 1001);
  } while (offset < 1001);
  assert.equal(new Set(all.map(row => row.id)).size, 1001); assert.equal(all.at(-1).title, 'Template 1001');
  const started = Date.now();
  const copied = await value(client.rpc('create_task_from_template', { p_project_id: project, p_template_id: template }));
  const result = (await env.db.query('select count(*)::int n,min(description) description from public.task_items where task_id=$1', [copied])).rows[0];
  assert.equal(result.n, 1001); assert.ok(result.description.startsWith('Instructions'));
  assert.equal((await env.db.query("select count(*)::int n from pg_trigger where tgrelid='public.task_items'::regclass and tgname like 'trg_task_items_status_%' and (tgtype&1)=0")).rows[0].n, 3);
  console.log('PASS OTHER-01/02: keyset reads and atomic copy of 1001 items; copy elapsed_ms=' + (Date.now() - started));
  // Current task access remains required after hard deletion and revoke.
  await value(client.rpc('archive_task_item', { p_task_item_id: item.id })); await value(client.rpc('hard_delete_task_item', { p_task_item_id: item.id }));
  assert.ok((await value(reader.from('audit_log').select('*').eq('entity_id', item.id))).some(row => row.new_data?.comment === 'Remote'));
  await value(client.rpc('remove_project_member', { p_project_id: project, p_user_id: member }));
  assert.equal((await value(reader.from('audit_log').select('*').eq('entity_id', item.id))).length, 0);
  console.log('PASS BUG-03: real RLS retains deleted item events and denies them after revoke');
} finally { api?.close(); await env.close(); }
