begin;
set local lock_timeout='5s';
-- Drain existing writers before installing any statement triggers.
do $drain$ declare t record; begin
for t in select c.oid::regclass relation from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by c.relname loop
execute format('lock table %s in share row exclusive mode',t.relation);
end loop; end $drain$;
-- Fence definition shared with the forward migration.

-- BEFORE the five unapplied migrations. No hosted values are assigned here.
create table if not exists private.release_write_control (
 singleton boolean primary key default true check(singleton), maintenance boolean not null default false
);
insert into private.release_write_control(singleton) values(true) on conflict do nothing;
alter table private.release_write_control enable row level security;
revoke all on private.release_write_control from public,anon,authenticated,service_role;

create or replace function private.require_auth() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare u uuid:=auth.uid();
begin
 if u is null then raise exception 'authentication required' using errcode='42501'; end if;
 if not exists(select 1 from auth.users where id=u and deleted_at is null) then
  raise exception 'Account unavailable' using errcode='28000'; end if;
 return u;
end $$;

create or replace function private.require_release_write() returns void
language plpgsql security definer set search_path='' as $$
begin
 -- Maintenance takes the exclusive counterpart and drains admitted writers.
 perform pg_advisory_xact_lock_shared(60182000::bigint);
 if coalesce((select maintenance from private.release_write_control where singleton),true) then
  raise exception 'Writes paused for a controlled release' using errcode='PT503',detail='TT_RELEASE_MAINTENANCE'; end if;
 perform private.require_auth();
end $$;

create or replace function private.guard_release_write() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- Migration/admin sessions have no API role. User DML, including DML outside
 -- RPC, takes the same fence. The role GUC is retained inside SECURITY DEFINER.
 if current_setting('role',true) in ('authenticated','anon','service_role') then
  perform private.require_release_write();
 end if;
 return null;
end $$;

do $fence$
declare t record;
begin
 for t in select c.oid::regclass as relation from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' order by c.relname loop
  if not exists(select 1 from pg_trigger where tgrelid=t.relation and tgname='tasktrace_release_write_fence') then
   execute format('create trigger tasktrace_release_write_fence before insert or update or delete on %s for each statement execute function private.guard_release_write()',t.relation);
  end if;
 end loop;
end $fence$;
revoke all on function private.require_release_write(),private.guard_release_write() from public,anon,authenticated,service_role;

update private.release_write_control set maintenance=true where singleton;
commit;
