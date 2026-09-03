-- Local Supabase test preflight. Do not create a fake auth schema.
-- Run after `npx supabase db reset` and before any SQL suite.
\set ON_ERROR_STOP on
do $$
begin
  if to_regclass('auth.users') is null then
    raise exception 'auth.users is missing; run npx supabase db reset';
  end if;
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    raise exception 'auth.uid() is missing; use the local Supabase Auth schema';
  end if;
  raise notice 'PASS local Supabase Auth schema preflight';
end $$;
