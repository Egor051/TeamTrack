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
  create extension if not exists pg_cron;
  perform cron.schedule('tasktrace-checklist-deadlines', '* * * * *',
    'select private.process_checklist_deadlines();');
end;
$$;
