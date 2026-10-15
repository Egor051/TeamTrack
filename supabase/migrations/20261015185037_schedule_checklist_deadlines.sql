-- Supabase Cron runs SQL inside Postgres, including while every client is
-- closed. Fail deployment if pg_cron cannot be installed in the app database.
-- An isolated regression database deliberately does not schedule live jobs.
do $$
begin
  if current_database() ~ '^teamtrack_audit_[0-9]+$' then
    raise notice 'Isolated database: deadline cron registration skipped (production migration must run in cron.database_name)';
    return;
  end if;
  if current_database() <> coalesce(nullif(current_setting('cron.database_name', true), ''), 'postgres') then
    raise exception 'Deadline scheduler must be installed in cron.database_name';
  end if;
  -- On hosted Supabase pg_cron may already be installed. Executing CREATE
  -- EXTENSION IF NOT EXISTS can still fire provider event hooks; skip it.
  if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    create extension pg_cron;
  end if;
  perform cron.schedule('tasktrace-checklist-deadlines', '* * * * *',
    'select private.process_checklist_deadlines();');
end;
$$;
