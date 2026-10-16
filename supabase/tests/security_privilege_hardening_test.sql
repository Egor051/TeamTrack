-- Explicit privilege boundary, future objects, trigger dependencies and RPC-only state.
begin;
set local role postgres;
create function public.security_default_probe() returns integer language sql security definer
set search_path='' as $$select 1$$;
create function private.security_default_probe() returns integer language sql security definer
set search_path='' as $$select 1$$;
create table public.security_default_probe(id integer);
create table private.security_default_probe(id integer);
create sequence public.security_default_probe_seq;
create sequence private.security_default_probe_seq;
reset role;

do $test$
declare role_name text; fn regprocedure; relation regclass; r record;
begin
 foreach role_name in array array['anon','authenticated','service_role'] loop
  foreach fn in array array['public.security_default_probe()'::regprocedure,'private.security_default_probe()'::regprocedure] loop
   if has_function_privilege(role_name,fn,'execute') then raise exception 'default execute exposed to %',role_name; end if;
  end loop;
  foreach relation in array array['public.security_default_probe'::regclass,'private.security_default_probe'::regclass] loop
   if has_table_privilege(role_name,relation,'select,insert,update,delete,truncate,references,trigger,maintain') then
    raise exception 'default table permissions exposed to %',role_name; end if;
  end loop;
  foreach relation in array array['public.security_default_probe_seq'::regclass,'private.security_default_probe_seq'::regclass] loop
   if has_sequence_privilege(role_name,relation,'usage,select,update') then raise exception 'default sequence exposed to %',role_name; end if;
  end loop;
 end loop;
 if exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   where p.oid in('public.security_default_probe()'::regprocedure,'private.security_default_probe()'::regprocedure)
    and a.grantee=0 and a.privilege_type='EXECUTE') then raise exception 'PUBLIC default EXECUTE remains'; end if;

 for r in select c.oid,n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in('public','private') and c.relkind='r'
 loop
  foreach role_name in array array['anon','authenticated'] loop
   if has_table_privilege(role_name,r.oid,'insert,update,delete,truncate,references,trigger,maintain') then
    raise exception 'direct writes/DDL remain: %.% %',r.nspname,r.relname,role_name; end if;
  end loop;
 end loop;
 for r in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.prorettype<>'trigger'::regtype and p.proname<>'security_default_probe'
 loop
  if has_function_privilege('anon',r.oid,'execute') or has_function_privilege('service_role',r.oid,'execute') then
   raise exception 'unexpected anon/service RPC grant %',r.proname; end if;
  if not has_function_privilege('authenticated',r.oid,'execute') then raise exception 'authenticated RPC broken %',r.proname; end if;
 end loop;
 if (select prosecdef from pg_proc where oid='public.set_task_item_progress(uuid,integer)'::regprocedure) then
  raise exception 'progress alias still definer'; end if;
 if (select count(*) from pg_proc p where p.oid in('public.set_updated_at()'::regprocedure,'public.prevent_history_mutation()'::regprocedure)
   and p.proconfig @>array['search_path=pg_catalog, pg_temp'])<>2 then raise exception 'mutable trigger path'; end if;
 if (select count(*) from pg_trigger where not tgisinternal and tgfoid='public.set_updated_at()'::regprocedure)<>4
  or (select count(*) from pg_trigger where not tgisinternal and tgfoid='public.prevent_history_mutation()'::regprocedure)<>6 then
  raise exception 'trigger attachments lost'; end if;
 if (select condeferrable from pg_constraint where conrelid='public.task_template_items'::regclass
  and conname='task_template_items_template_position_key') then raise exception 'ordering contract is not strict unique'; end if;
end $test$;

-- Explicit GRANT in a later migration re-opens only the selected safe endpoint.
grant execute on function public.security_default_probe() to authenticated;
set local role authenticated;
select public.security_default_probe();
reset role;
rollback;
