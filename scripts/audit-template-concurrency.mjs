import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

// Called only for the isolated database created by run-audit-sql-tests.mjs.
export async function verifyTemplateConcurrency(port, database) {
  if (!/^teamtrack_audit_\d+$/.test(database) || !Number.isInteger(port)) throw new Error('Isolated local database required');
  const clients = ['observer', 'editor', 'mover', 'copier'].map((name) => new pg.Client({
    host: '127.0.0.1', port, database, user: 'supabase_admin', password: 'postgres',
    application_name: `${database}_${name}`, statement_timeout: 10_000,
  }));
  const [observer, editor, mover, copier] = clients;
  const owner = randomUUID();
  const begin = async (client) => { await client.query('begin'); await client.query('set local role authenticated');
    await client.query("select set_config('request.jwt.claim.sub',$1,true)", [owner]); };
  const asUser = async (client, action) => {
    await begin(client);
    try { const value = await action(); await client.query('commit'); return value; }
    catch (error) { await client.query('rollback'); throw error; }
  };
  const waiting = async (client) => {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const result = await observer.query("select wait_event_type from pg_stat_activity where application_name=$1 and state='active'", [client.connectionParameters.application_name]);
      if (result.rows.some((row) => row.wait_event_type === 'Lock')) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Concurrent RPC did not reach the expected parent lock');
  };
  try {
    await Promise.all(clients.map((client) => client.connect()));
    await observer.query("insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,'{\"display_name\":\"Concurrency Owner\"}')", [owner, `${owner}@example.test`]);
    const fixture = await asUser(observer, async () => {
      const project = (await observer.query("select public.create_project('Concurrent ordering') id")).rows[0].id;
      const template = (await observer.query("select public.create_task_template('Concurrent ordering') id")).rows[0].id;
      const ids = [];
      for (const title of ['A', 'B', 'C']) ids.push((await observer.query('select public.create_task_template_item($1,$2) id', [template, title])).rows[0].id);
      return { project, template, ids };
    });
    await begin(editor);
    await editor.query('select public.update_task_template_item($1,$2,$3)', [fixture.ids[1], 'NEW', 'Independent text']);
    // Reorder/copy started with old rendered content but must read after the
    // text edit's parent lock. Observe a real wait, not a guessed sleep.
    const move = asUser(mover, () => mover.query('select public.move_task_template_item($1,-1)', [fixture.ids[1]]));
    const moved = move.then(() => ({ error: null }), (error) => ({ error }));
    const copy = asUser(copier, () => copier.query('select public.create_task_from_template($1,$2) id', [fixture.project, fixture.template]));
    const copied = copy.then((result) => ({ result }), (error) => ({ error }));
    await waiting(mover); await waiting(copier); await editor.query('commit');
    const moveResult = await moved; if (moveResult.error) throw moveResult.error;
    const copyResult = await copied; if (copyResult.error) throw copyResult.error;
    const rows = (await observer.query('select title,description,position from public.task_template_items where template_id=$1 order by position', [fixture.template])).rows;
    assert.deepEqual(rows.map((row) => row.title), ['NEW', 'A', 'C']);
    assert.equal(rows[0].description, 'Independent text');
    const copyRows = (await observer.query('select title,position from public.task_items where task_id=$1 order by position', [copyResult.result.rows[0].id])).rows;
    assert.deepEqual(copyRows.map((row) => Number(row.position)), [1, 2, 3]);
    assert(copyRows.some((row) => row.title === 'NEW') && !copyRows.some((row) => row.title === 'B'));
    console.log('PASS AUD-07: text edit → waiting reorder/copy retain independently saved fields');

    for (let pair = 0; pair < 5; pair++) await Promise.all([
      asUser(mover, () => mover.query('select public.create_task_template_item($1,$2)', [fixture.template, `D${pair}`])),
      asUser(copier, () => copier.query('select public.create_task_template_item($1,$2)', [fixture.template, `E${pair}`])),
    ]);
    const positions = (await observer.query('select position from public.task_template_items where template_id=$1 order by position', [fixture.template])).rows.map((row) => Number(row.position));
    assert.deepEqual(positions, Array.from({ length: 13 }, (_, i) => i + 1));
    console.log('PASS AUD-05/06: concurrent append preserves unique positions and visible order');

    await begin(editor);
    // Hold the parent through its authorized RPC; clients have no UPDATE ACL.
    await editor.query("select public.update_task_template($1,'Concurrent ordering')", [fixture.template]);
    const afterDelete = asUser(mover, () => mover.query('select public.move_task_template_item($1,-1)', [fixture.ids[0]]));
    const deletionResult = afterDelete.then(() => null, (error) => error);
    await waiting(mover);
    await editor.query('select public.delete_task_template_item($1)', [fixture.ids[0]]);
    await editor.query('commit');
    assert.equal((await deletionResult)?.message, 'template item not found');
    assert((await observer.query("select 1 from public.audit_log where entity_id=$1 and action='removed'", [fixture.ids[0]])).rowCount > 0);
    console.log('PASS AUD-06/07: delete while reorder waits is rejected atomically and history survives');
  } finally {
    await Promise.all(clients.map(async (client) => { try { await client.query('rollback'); } catch { /* Failed connection/closed worker. */ } await client.end(); }));
  }
}
