import { fixtureCas } from './fixture-cas.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PostgrestClient } from '@supabase/postgrest-js';

export async function verifyStageMembershipIntegration({ api, db, owner, token, project, task, item }) {
  const data = async (query) => { const result = await query; if (result.error) throw new Error(JSON.stringify(result.error)); return result.data; };
  const guestId = randomUUID();
  await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [guestId, `${guestId}@stage.test`]);
  const guest = new PostgrestClient(api, { headers: { Authorization: `Bearer ${token(guestId)}` } });
  const reply = await data(owner.rpc('add_task_member_by_identifier', { p_task_id: task, p_identifier: `${guestId}@stage.test`, p_role: 'member' }));
  assert.equal(reply.success, true);
  assert.equal((await data(guest.from('projects').select('*'))).length, 0);
  assert.equal((await data(guest.from('tasks').select('*'))).length, 1);
  assert.equal((await data(guest.rpc('get_task_project_context', { p_task_id: task }))).role, null);
  assert.ok((await data(guest.rpc('list_task_participants', { p_task_id: task }))).some((row) => row.user_id === guestId && row.is_direct));
  const version = (await data(guest.from('task_items').select('sync_version').eq('id', item).single())).sync_version;
  const operation = randomUUID();
  const applied = await data(guest.rpc('apply_task_item_percentage_operation_v2', { p_operation_id: operation, p_task_item_id: item, p_expected_version: version, p_percentage: 37 }));
  assert.equal(applied.status, 'applied');
  const repeated = await data(guest.rpc('apply_task_item_percentage_operation_v2', { p_operation_id: operation, p_task_item_id: item, p_expected_version: version, p_percentage: 37 }));
  assert.equal(repeated.status, 'applied');
  assert.equal((await data(guest.from('checklist_overview').select('*').eq('id', item))).length, 1);
  await data(owner.rpc('add_task_assignee', { p_task_id: task, p_user_id: guestId }));
  const current = await data(guest.from('task_items').select('sync_version').eq('id', item).single());
  await data(owner.rpc('set_task_item_deadline', { p_task_item_id: item, p_expected_version: current.sync_version, p_deadline_at: new Date(Date.now()+86_400_000).toISOString() }));
  assert.ok((await data(guest.from('notifications').select('*'))).some((row) => row.data?.deadline_event === 'set'));
  const notificationQuery = () => guest.from('notifications').select('*').in('project_id', [project, randomUUID()]).in('task_id', [task, randomUUID()])
    .or('type.in.(task_assigned),data->>deadline_event.in.(set,overdue)').eq('is_read', false)
    .order('created_at', { ascending: false }).order('id', { ascending: false });
  const notices = await data(notificationQuery());
  assert.equal(notices.length, 2); assert.ok(notices.some((row) => row.type === 'task_assigned')); assert.ok(notices.some((row) => row.data?.deadline_event === 'set'));
  assert.equal((await data(notificationQuery().range(0, 0)))[0].id, notices[0].id);
  assert.equal((await data(notificationQuery().range(1, 1)))[0].id, notices[1].id);
  assert.ok((await db.query("select 1 from realtime.messages where topic=$1 and payload->>'table'='task_items'", [`user:${guestId}`])).rowCount > 0);
  const manifest = await data(guest.rpc('get_offline_account_manifest', { p_scheme: 'basic' }));
  assert.equal(manifest.datasets.tasks.count, 1); assert.equal(manifest.datasets.projects.count, 0);
  assert.equal((await guest.rpc('set_task_member_override', { p_task_id: task, p_user_id: guestId, p_role: 'admin' })).error?.code, '42501');
  const before = await data(owner.from('tasks').select('title,description').eq('id', task).single());
  // A status/progress update is unrelated to an editor's title/description base.
  await data(fixtureCas(guest, 'set_task_item_percentage', { p_task_item_id: item, p_percentage: 0 }));
  const args = { p_task_id: task, p_expected_title: before.title, p_expected_description: before.description ?? '' };
  const edits = await Promise.all(['First concurrent title', 'Second concurrent title'].map((p_title) => fixtureCas(owner, 'update_task', { ...args, p_title, p_description: 'Concurrent description' })));
  assert.equal(edits.filter((result) => !result.error).length, 1);
  assert.equal(edits.filter((result) => result.error?.code === 'PT409').length, 1);
  await data(fixtureCas(owner, 'update_task', { p_task_id: task, p_title: before.title, p_description: before.description ?? '' }));
  await data(owner.rpc('remove_task_member', { p_task_id: task, p_user_id: guestId }));
  assert.equal((await data(guest.from('tasks').select('*'))).length, 0);
  assert.equal((await data(guest.from('task_items').select('*'))).length, 0);
  assert.equal((await guest.rpc('get_task_project_context', { p_task_id: task })).error?.code, '42501');
  assert.equal((await db.query('select count(*)::int n from public.task_assignees where task_id=$1 and user_id=$2', [task,guestId])).rows[0].n, 0);
  console.log('PASS stage Data API: independent membership, minimal context, RLS, Broadcast/deadline fanout, offline manifest and idempotent outbox replay, access revocation');
  console.log('PASS concurrent stage editing: one winner, one PT409, unrelated checklist updates do not conflict');
  console.log('PASS notification Data API: OR across ordinary/deadline types, AND across categories, deterministic filtered pagination');
}
