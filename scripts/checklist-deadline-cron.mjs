import { spawnSync } from 'node:child_process';

/** Verify the actual pg_cron worker in an entirely disposable Postgres server. */
export async function verifyDeadlineCron(sourceContainer, base, upgrade) {
  const name = `tasktrace-cron-${process.pid}`;
  const docker = (args, input) => {
    const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout); return r.stdout;
  };
  const image = docker(['inspect', sourceContainer, '--format', '{{.Config.Image}}']).trim();
  const database = 'deadline_cron_test';
  const sql = (source, db = database) => docker(['exec', '-i', name, 'psql', '-X', '-U', 'supabase_admin', '-d', db, '-v', 'ON_ERROR_STOP=1'], source);
  try {
    docker(['run', '--rm', '-d', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data',
      '-e', 'POSTGRES_PASSWORD=postgres', image, 'postgres', '-D', '/etc/postgresql',
      '-c', 'shared_preload_libraries=pg_cron', '-c', `cron.database_name=${database}`, '-c', 'cron.use_background_workers=on']);
    let ready = false;
    for (let n = 0; n < 60; n++) {
      // The image's initialization server listens only on its Unix socket.
      // TCP becomes ready only after initialization and the final restart.
      const r = spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], { encoding: 'utf8' });
      if (r.status === 0) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!ready) throw new Error('Disposable Cron database startup failed');
    // template0 avoids the image's preloaded GraphQL/Auth objects and event
    // triggers. Never drop or alter those bundled schemas in the image's DB.
    sql(`create database ${database} owner postgres template template0;`, 'postgres');
    sql(`${base}\ngrant usage,create on schema public to postgres; create schema extensions authorization postgres; create extension pgcrypto with schema extensions; create publication supabase_realtime; grant usage on schema auth,realtime to authenticated,anon,postgres; grant execute on all functions in schema auth,realtime to authenticated,anon,postgres; grant all on all tables in schema auth,realtime to postgres; grant all on all sequences in schema auth,realtime to postgres;\n${upgrade}`);
    sql(`do $$begin if not exists(select 1 from cron.job where jobname='tasktrace-checklist-deadlines' and schedule='* * * * *' and active and username='postgres' and command='select private.process_checklist_deadlines();') then raise exception 'Production Cron migration did not register the postgres job'; end if; end$$;
      select cron.alter_job((select jobid from cron.job where jobname='tasktrace-checklist-deadlines'),schedule:='1 second');
      insert into auth.users(id,email,raw_user_meta_data) values ('96000000-0000-4000-8000-000000000001','cron@test.local','{}');
      set role authenticated; select set_config('request.jwt.claim.sub','96000000-0000-4000-8000-000000000001',false);
      select public.create_project('Cron deadline test') as project \\gset
      select public.create_task(:'project','Cron stage') as task \\gset
      select public.create_task_item(:'task','Cron checklist') as item \\gset
      select public.set_task_item_deadline(:'item',clock_timestamp()+interval '2 seconds',1);
      reset role;`);
    let delivered = false;
    for (let n = 0; n < 30; n++) {
      const result = sql("select count(*) from public.notifications where data->>'deadline_event'='overdue' and user_id='96000000-0000-4000-8000-000000000001';");
      if (/\n\s*1\s*\n/.test(result)) { delivered = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!delivered) throw new Error('Actual Cron worker did not create the overdue notification');
    sql(`select pg_sleep(2); do $$begin if (select count(*) from public.notifications where data->>'deadline_event'='overdue' and user_id='96000000-0000-4000-8000-000000000001')<>1 then raise exception 'Cron repeated notification'; end if; end$$;`);
    console.log('PASS actual pg_cron: production migration registers the job; background execution creates exactly one overdue notification with all apps closed');
  } finally { spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' }); }
}
