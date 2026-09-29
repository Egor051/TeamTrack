import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';

const { Client } = pg;
const local = getLocalSupabaseStatus();
const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const ownerId = randomUUID();
const memberId = randomUUID();
let projectId;
let taskId;
let itemId;
let deleteTaskId;

function dbClient(applicationName) {
  return new Client({ connectionString: local.DB_URL, application_name: applicationName });
}

async function asUser(client, userId, callback) {
  await client.query('begin');
  try {
    await client.query('set local role authenticated');
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
    const value = await callback();
    await client.query('commit');
    return value;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

async function waitForWaitEvent(observer, applicationName, expected, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await observer.query(
      `select wait_event_type, wait_event
         from pg_stat_activity
        where application_name=$1 and state='active'`,
      [applicationName],
    );
    if (result.rows.some((row) => expected(row))) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${applicationName} did not reach the expected wait state`);
}

const observer = dbClient(`tt_observer_${nonce}`);
const blocker = dbClient(`tt_blocker_${nonce}`);
const memberWriter = dbClient(`tt_member_writer_${nonce}`);
const archiveWriter = dbClient(`tt_archive_writer_${nonce}`);
const hardDelete = dbClient(`tt_hard_delete_${nonce}`);
const restoreTask = dbClient(`tt_restore_task_${nonce}`);
const allClients = [observer, blocker, memberWriter, archiveWriter, hardDelete, restoreTask];

try {
  await Promise.all(allClients.map((client) => client.connect()));
  await observer.query(
    `insert into auth.users
       (id,email,aud,role,raw_app_meta_data,raw_user_meta_data,email_confirmed_at,created_at,updated_at,is_anonymous,is_sso_user)
     values
       ($1,$2,'authenticated','authenticated','{}',$3::jsonb,now(),now(),now(),false,false),
       ($4,$5,'authenticated','authenticated','{}',$6::jsonb,now(),now(),now(),false,false)`,
    [
      ownerId, `concurrency-owner-${nonce}@test.local`, JSON.stringify({ display_name: 'Concurrency Owner' }),
      memberId, `concurrency-member-${nonce}@test.local`, JSON.stringify({ display_name: 'Concurrency Member' }),
    ],
  );

  await asUser(observer, ownerId, async () => {
    projectId = (await observer.query('select public.create_project($1,$2) id', [`Concurrency ${nonce}`, 'locking regression'])).rows[0].id;
    await observer.query("select public.add_project_member($1,$2,'member')", [projectId, memberId]);
    taskId = (await observer.query('select public.create_task($1,$2,$3) id', [projectId, 'Concurrent stage', 'active'])).rows[0].id;
    itemId = (await observer.query('select public.create_task_item($1,$2) id', [taskId, 'Concurrent item'])).rows[0].id;
  });

  // The member write starts first but blocks on the canonical project lock.
  // Revocation commits while it waits; authorization is then rechecked and the
  // stale write must fail.
  await blocker.query('begin');
  await blocker.query('select id from public.projects where id=$1 for update', [projectId]);
  const revokedWrite = asUser(memberWriter, memberId, () => memberWriter.query(
    'select public.set_task_item_comment($1,$2)', [itemId, 'must not commit after revocation'],
  ));
  await waitForWaitEvent(observer, `tt_member_writer_${nonce}`, (row) => row.wait_event_type === 'Lock');
  await blocker.query('delete from public.project_members where project_id=$1 and user_id=$2', [projectId, memberId]);
  await blocker.query('commit');
  const revokedResult = await Promise.allSettled([revokedWrite]);
  assert.equal(revokedResult[0].status, 'rejected');
  assert.equal(revokedResult[0].reason.code, '42501');
  assert.equal((await observer.query('select comment from public.task_items where id=$1', [itemId])).rows[0].comment, null);

  await asUser(observer, ownerId, () => observer.query("select public.add_project_member($1,$2,'member')", [projectId, memberId]));

  // Archive wins the project lock while a progress write is waiting. The
  // post-lock state check rejects the write instead of mutating archived work.
  await blocker.query('begin');
  await blocker.query('select id from public.projects where id=$1 for update', [projectId]);
  const archivedWrite = asUser(archiveWriter, memberId, () => archiveWriter.query(
    'select public.set_task_item_percentage($1,$2)', [itemId, 77],
  ));
  await waitForWaitEvent(observer, `tt_archive_writer_${nonce}`, (row) => row.wait_event_type === 'Lock');
  await blocker.query("update public.projects set status='archived', archived_at=now() where id=$1", [projectId]);
  await blocker.query('commit');
  const archivedResult = await Promise.allSettled([archivedWrite]);
  assert.equal(archivedResult[0].status, 'rejected');
  assert.notEqual(archivedResult[0].reason.code, '40P01');
  assert.equal((await observer.query('select percentage from public.task_items where id=$1', [itemId])).rows[0].percentage, 0);
  await asUser(observer, ownerId, () => observer.query('select public.restore_project($1)', [projectId]));

  // Two simultaneous claims of the same receipt must serialize at the unique
  // key. Both callers get the stored result, with one canonical side effect.
  const operationId = randomUUID();
  const beforeAudit = Number((await observer.query(
    "select count(*) n from public.audit_log where entity_type='task_item' and entity_id=$1", [itemId],
  )).rows[0].n);
  const beforeNotifications = Number((await observer.query(
    "select count(*) n from public.notifications where data->>'entity_id'=$1", [itemId],
  )).rows[0].n);
  const duplicates = await Promise.all([
    asUser(memberWriter, memberId, () => memberWriter.query(
      'select public.apply_task_item_percentage_operation($1,$2,$3) result', [operationId, itemId, 42],
    )),
    asUser(archiveWriter, memberId, () => archiveWriter.query(
      'select public.apply_task_item_percentage_operation($1,$2,$3) result', [operationId, itemId, 42],
    )),
  ]);
  assert.deepEqual(duplicates.map((result) => result.rows[0].result), [42, 42]);
  assert.equal(Number((await observer.query(
    "select count(*) n from public.audit_log where entity_type='task_item' and entity_id=$1", [itemId],
  )).rows[0].n), beforeAudit + 1);
  const afterNotifications = Number((await observer.query(
    "select count(*) n from public.notifications where data->>'entity_id'=$1", [itemId],
  )).rows[0].n);
  assert.ok(afterNotifications >= beforeNotifications);
  await asUser(memberWriter, memberId, () => memberWriter.query(
    'select public.apply_task_item_percentage_operation($1,$2,$3)', [operationId, itemId, 42],
  ));
  assert.equal(Number((await observer.query(
    "select count(*) n from public.notifications where data->>'entity_id'=$1", [itemId],
  )).rows[0].n), afterNotifications);
  assert.equal(Number((await observer.query(
    "select count(*) n from public.audit_log where entity_type='task_item' and entity_id=$1", [itemId],
  )).rows[0].n), beforeAudit + 1);

  // Force hard-delete to pause while holding project -> task locks. A parallel
  // restore follows the same order, waits, and finishes without a deadlock.
  await asUser(observer, ownerId, async () => {
    deleteTaskId = (await observer.query('select public.create_task($1,$2,$3) id', [projectId, 'Delete race stage', 'race'])).rows[0].id;
    await observer.query('select public.archive_task($1)', [deleteTaskId]);
  });
  await observer.query(`
    create or replace function private.test_pause_task_delete()
    returns trigger language plpgsql set search_path='' as $$
    begin perform pg_sleep(0.8); return old; end $$;
    drop trigger if exists test_pause_task_delete on public.tasks;
    create trigger test_pause_task_delete before delete on public.tasks
    for each row execute function private.test_pause_task_delete()
  `);

  const hardDeleteCall = asUser(hardDelete, ownerId, () => hardDelete.query('select public.hard_delete_task($1)', [deleteTaskId]));
  await waitForWaitEvent(observer, `tt_hard_delete_${nonce}`, (row) => row.wait_event === 'PgSleep');
  const restoreCall = asUser(restoreTask, ownerId, () => restoreTask.query('select public.restore_task($1)', [deleteTaskId]));
  await waitForWaitEvent(observer, `tt_restore_task_${nonce}`, (row) => row.wait_event_type === 'Lock');
  const lockOrderResults = await Promise.allSettled([hardDeleteCall, restoreCall]);
  assert.equal(lockOrderResults[0].status, 'fulfilled', 'hard delete did not complete');
  assert.ok(lockOrderResults.every((result) => result.status === 'fulfilled' || result.reason?.code !== '40P01'), 'canonical operations deadlocked');

  console.log('Two-session concurrency regressions passed.');
} finally {
  if (blocker._connected) await blocker.query('rollback').catch(() => undefined);
  if (observer._connected) {
    await observer.query('drop trigger if exists test_pause_task_delete on public.tasks').catch(() => undefined);
    await observer.query('drop function if exists private.test_pause_task_delete()').catch(() => undefined);
    if (projectId) {
      await asUser(observer, ownerId, async () => {
        await observer.query('select public.archive_project($1)', [projectId]).catch(() => undefined);
        await observer.query('select public.hard_delete_project($1)', [projectId]).catch(() => undefined);
      }).catch(() => undefined);
    }
  }
  await Promise.all(allClients.map((client) => client.end().catch(() => undefined)));
}
