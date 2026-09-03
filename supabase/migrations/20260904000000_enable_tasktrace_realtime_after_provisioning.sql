-- Enable Postgres Changes only after all TaskTrace tables exist.
-- Idempotent for production projects where the earlier migration already ran.
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'projects', 'project_members', 'tasks', 'task_members',
    'task_assignees', 'task_items', 'item_actions', 'audit_log'
  ] loop
    if not exists (
      select 1
      from pg_publication p
      join pg_publication_rel pr on pr.prpubid = p.oid
      join pg_class c on c.oid = pr.prrelid
      join pg_namespace n on n.oid = c.relnamespace
      where p.pubname = 'supabase_realtime'
        and n.nspname = 'public'
        and c.relname = tbl
    ) then
      execute format('alter publication supabase_realtime add table public.%I', tbl);
    end if;
  end loop;
end $$;
