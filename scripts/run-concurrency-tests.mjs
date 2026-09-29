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

  // v2 duplicates serialize on the same receipt, then return one stored
  // success even though the successful write advanced sync_version.
  const versionBeforeV2 = Number((await observer.query('select sync_version from public.task_items where id=$1', [itemId])).rows[0].sync_version);
  const v2OperationId = randomUUID();
  const auditBeforeV2 = Number((await observer.query(
    "select count(*) n from public.audit_log where entity_type='task_item' and entity_id=$1", [itemId],
  )).rows[0].n);
  const v2Duplicates = await Promise.all([
    asUser(memberWriter, memberId, () => memberWriter.query(
      'select public.apply_task_item_percentage_operation_v2($1,$2,$3,$4) result', [v2OperationId, itemId, versionBeforeV2, 65],
    )),
    asUser(archiveWriter, memberId, () => archiveWriter.query(
      'select public.apply_task_item_percentage_operation_v2($1,$2,$3,$4) result', [v2OperationId, itemId, versionBeforeV2, 65],
    )),
  ]);
  assert.deepEqual(v2Duplicates.map((result) => result.rows[0].result.status), ['applied', 'applied']);
  assert.deepEqual(v2Duplicates.map((result) => Number(result.rows[0].result.version)),
    [versionBeforeV2 + 1, versionBeforeV2 + 1]);
  assert.equal(Number((await observer.query(
    "select count(*) n from public.audit_log where entity_type='task_item' and entity_id=$1", [itemId],
  )).rows[0].n), auditBeforeV2 + 1);
  assert.equal(Number((await observer.query('select percentage from public.task_items where id=$1', [itemId])).rows[0].percentage), 65);

  // A mismatch creates no receipt or audit, so the same semantic operation
  // can be retried after explicit user resolution with a fresh precondition.
  const conflictedId = randomUUID();
  const stale = await asUser(memberWriter, memberId, () => memberWriter.query(
    'select public.apply_task_item_percentage_operation_v2($1,$2,$3,$4) result', [conflictedId, itemId, versionBeforeV2, 70],
  ));
  assert.equal(stale.rows[0].result.status, 'conflict');
  assert.equal(Number((await observer.query(
    'select count(*) n from private.client_operation_receipts where user_id=$1 and operation_id=$2', [memberId, conflictedId],
  )).rows[0].n), 0);
  assert.equal(Number((await observer.query(
    "select count(*) n from public.audit_log where entity_type='task_item' and entity_id=$1", [itemId],
  )).rows[0].n), auditBeforeV2 + 1);
  const currentVersion = Number(stale.rows[0].result.version);
  const resolved = await asUser(memberWriter, memberId, () => memberWriter.query(
    'select public.apply_task_item_percentage_operation_v2($1,$2,$3,$4) result', [conflictedId, itemId, currentVersion, 70],
  ));
  assert.equal(resolved.rows[0].result.status, 'applied');
  assert.equal(Number((await observer.query('select percentage from public.task_items where id=$1', [itemId])).rows[0].percentage), 70);

  // A second server write before the user's choice forces another conflict.
  const secondConflictId = randomUUID();
  await asUser(observer, ownerId, () => observer.query('select public.set_task_item_percentage($1,$2)', [itemId, 80]));
  const firstConflict = await asUser(memberWriter, memberId, () => memberWriter.query(
    'select public.apply_task_item_percentage_operation_v2($1,$2,$3,$4) result',
    [secondConflictId, itemId, Number(resolved.rows[0].result.version), 90],
  ));
  assert.equal(firstConflict.rows[0].result.status, 'conflict');
  await asUser(observer, ownerId, () => observer.query('select public.set_task_item_percentage($1,$2)', [itemId, 55]));
  const secondConflict = await asUser(memberWriter, memberId, () => memberWriter.query(
    'select public.apply_task_item_percentage_operation_v2($1,$2,$3,$4) result',
    [secondConflictId, itemId, Number(firstConflict.rows[0].result.version), 90],
  ));
  assert.equal(secondConflict.rows[0].result.status, 'conflict');
  assert.equal(Number((await observer.query('select percentage from public.task_items where id=$1', [itemId])).rows[0].percentage), 55);

  // Remote write wins the project lock before a v2 replay. The RPC's version
  // check runs after the lock and cannot overwrite that committed write.
  const raceVersion = Number((await observer.query('select sync_version from public.task_items where id=$1', [itemId])).rows[0].sync_version);
  await blocker.query('begin');
  await blocker.query('select id from public.projects where id=$1 for update', [projectId]);
  const raceWrite = asUser(memberWriter, memberId, () => memberWriter.query(
    'select public.apply_task_item_percentage_operation_v2($1,$2,$3,$4) result', [randomUUID(), itemId, raceVersion, 95],
  ));
  await waitForWaitEvent(observer, `tt_member_writer_${nonce}`, (row) => row.wait_event_type === 'Lock');
  await blocker.query('set local role authenticated');
  await blocker.query("select set_config('request.jwt.claim.sub',$1,true)", [ownerId]);
  await blocker.query('select public.set_task_item_percentage($1,$2)', [itemId, 85]);
  await blocker.query('commit');
  assert.equal((await raceWrite).rows[0].result.status, 'conflict');
  assert.equal(Number((await observer.query('select percentage from public.task_items where id=$1', [itemId])).rows[0].percentage), 85);

  // Revocation while the v2 caller waits on the parent lock fails closed.
  const revocationVersion = Number((await observer.query('select sync_version from public.task_items where id=$1', [itemId])).rows[0].sync_version);
  await blocker.query('begin');
  await blocker.query('select id from public.projects where id=$1 for update', [projectId]);
  const revokedV2 = asUser(memberWriter, memberId, () => memberWriter.query(
    'select public.apply_task_item_comment_operation_v2($1,$2,$3,$4) result',
    [randomUUID(), itemId, revocationVersion, 'must not commit'],
  ));
  await waitForWaitEvent(observer, `tt_member_writer_${nonce}`, (row) => row.wait_event_type === 'Lock');
  await blocker.query('delete from public.project_members where project_id=$1 and user_id=$2', [projectId, memberId]);
  await blocker.query('commit');
  const revokedV2Result = await Promise.allSettled([revokedV2]);
  assert.equal(revokedV2Result[0].status, 'rejected');
  assert.equal(revokedV2Result[0].reason.code, '42501');
  assert.equal((await observer.query('select comment from public.task_items where id=$1', [itemId])).rows[0].comment, null);
  await asUser(observer, ownerId, () => observer.query("select public.add_project_member($1,$2,'member')", [projectId, memberId]));

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
