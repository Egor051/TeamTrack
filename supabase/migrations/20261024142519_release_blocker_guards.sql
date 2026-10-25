begin;
set local lock_timeout='5s';

-- BEGIN RELEASE FENCE: also installed by the reviewed maintenance preflight,
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
-- END RELEASE FENCE

-- A single authoritative account check now also protects the direct paths.
-- Direct legacy business calls remain compatible until irreversible cutover;
-- v3 dispatch sets the existing transaction-local write_protocol marker.
create function private.require_mutation_entry() returns void
language plpgsql security definer set search_path='' as $$
begin
 perform private.require_release_write();
 if current_setting('tasktrace.write_protocol',true)='3' then return; end if;
 if not exists(select 1 from private.client_operation_policy where max_receipts is not null and max_logical_bytes is not null
  and max_request_bytes is not null and max_result_bytes is not null and new_per_minute is not null) then
  raise exception 'Legacy policy requires configuration' using errcode='PT503',detail='TT_RECEIPT_POLICY'; end if;
 perform pg_advisory_xact_lock_shared(60182001::bigint);
 perform pg_advisory_xact_lock_shared(60182002::bigint);
 if exists(select 1 from private.client_operation_history where legacy_closed or legacy_retired)
  or exists(select 1 from private.client_operation_window_policy where legacy_admit_until<=private.operation_clock()) then
  raise exception 'Update the application before starting a new action' using errcode='PT426',detail='TT_LEGACY_WRITE_CLOSED'; end if;
end $$;
revoke all on function private.require_mutation_entry() from public,anon,authenticated,service_role;

-- Inventory is materialized for release preflight and coverage checks. No
-- EXECUTE grants or business ACLs are removed or widened by this migration.
create table private.mutation_entry_inventory(signature text primary key, name text not null);
alter table private.mutation_entry_inventory enable row level security;
revoke all on private.mutation_entry_inventory from public,anon,authenticated,service_role;
do $entries$
declare f record; definition text; rewritten text;
begin
 for f in select p.oid,p.proname,p.oid::regprocedure signature,l.lanname
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
  where n.nspname='public' and p.prokind='f'
   and p.proname ~ '^(create_|update_|set_|delete_|hard_delete_|archive_|restore_|move_|add_|remove_|change_|clear_|transfer_|mark_)'
   and has_function_privilege('authenticated',p.oid,'execute')
  order by p.oid::regprocedure::text loop
  definition:=pg_get_functiondef(f.oid);
  if f.lanname='sql' and f.proname='set_task_item_progress'
   and definition like '%select public.set_task_item_percentage(p_task_item_id,p_completion_percent);%' then
   -- The released SECURITY INVOKER alias delegates only to the guarded entry.
   insert into private.mutation_entry_inventory values(f.signature::text,f.proname);
   continue;
  end if;
  if f.lanname<>'plpgsql' then raise exception 'Unreviewed mutation language: %',f.signature; end if;
  rewritten:=regexp_replace(definition,'\mBEGIN\M',E'BEGIN\n PERFORM private.require_mutation_entry();','i');
  if rewritten=definition then raise exception 'Mutation entry not guarded: %',f.signature; end if;
  execute rewritten;
  insert into private.mutation_entry_inventory values(f.signature::text,f.proname);
 end loop;
 if not exists(select 1 from private.mutation_entry_inventory where name='create_project') then raise exception 'Missing mutation inventory'; end if;
 -- V3 uses the same dispatch implementation, without falling into the legacy
 -- direct-call gate. Restore the marker after invocation (also on exceptions).
 definition:=pg_get_functiondef('private.invoke_client_mutation_v3(uuid,text,jsonb)'::regprocedure);
 definition:=regexp_replace(definition,'\mBEGIN\M',E'BEGIN\n PERFORM set_config(''tasktrace.write_protocol'',''3'',true);','i');
 execute definition;
end $entries$;

-- Old native JS parses only id/name/args. Even if it receives an exported v3
-- envelope, UUIDv8 cannot enter legacy, including AFTER v3 GC. Existing IDs and
-- historical legacy replay are preserved; pre-release v4 v3 IDs are fenced
-- while retained. No unbounded operation-ID tombstone table is introduced.
do $namespace$
declare definition text;
begin
 definition:=pg_get_functiondef('private.claim_client_operation(uuid,text,uuid,jsonb)'::regprocedure);
 definition:=regexp_replace(definition,'\mBEGIN\M',E'BEGIN\n IF (substring(p_operation_id::text,15,1)=''8'' AND NOT EXISTS(SELECT 1 FROM private.client_operation_receipts WHERE user_id=auth.uid() AND operation_id=p_operation_id)) OR EXISTS(SELECT 1 FROM private.client_operation_receipts_v3 WHERE user_id=auth.uid() AND operation_id=p_operation_id) THEN RAISE EXCEPTION ''v3 attempt cannot execute in legacy namespace'' USING ERRCODE=''PT409'',DETAIL=''TT_OPERATION_NAMESPACE''; END IF;','i');
 execute definition;
end $namespace$;
create index client_operation_receipts_v3_legacy_fence on private.client_operation_receipts_v3(user_id,operation_id);

-- Admission takes the release fence BEFORE lineage/epoch/budget locks. Thus
-- maintenance also drains protocol requests that have not reached business DML
-- yet, including a CAS conflict/no-op. Read-only resolvers remain available.
do $protocol_fence$
declare signature text; definition text;
begin
 foreach signature in array array['public.get_client_operation_context()',
  'private.claim_client_operation_v3(uuid,bigint,uuid,text,uuid,jsonb)',
  'private.claim_client_operation(uuid,text,uuid,jsonb)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  definition:=regexp_replace(definition,'\mBEGIN\M',E'BEGIN\n PERFORM private.require_release_write();','i');
  execute definition;
 end loop;
end $protocol_fence$;

create function private.assert_release_policies() returns void
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from private.client_operation_policy where max_receipts is not null and max_logical_bytes is not null
  and max_request_bytes is not null and max_result_bytes is not null and new_per_minute is not null)
  or not exists(select 1 from private.client_operation_window_policy where admission_seconds is not null and replay_seconds is not null
  and max_receipts is not null and max_logical_bytes is not null and max_global_receipts is not null and max_global_bytes is not null
  and max_request_bytes is not null and max_result_bytes is not null and new_per_minute is not null
  and legacy_admit_until is not null and legacy_replay_until is not null) then
  raise exception 'Both release policies and cutoffs must be configured' using errcode='PT503',detail='TT_RECEIPT_POLICY'; end if;
 -- Pre-release v3 builds used UUIDv4. Their IDs remain unchanged, so legacy
 -- admission must end before any such receipt can be forgotten. New UUIDv8
 -- attempts retain the permanent namespace fence independently of retention.
 if exists(select 1 from private.client_operation_receipts_v3 r join private.client_operation_epochs e using(generation,epoch)
  cross join private.client_operation_window_policy p where substring(r.operation_id::text,15,1)<>'8'
   and p.legacy_admit_until>e.replay_until) then
  raise exception 'Legacy cutoff must precede GC of pre-release v3 IDs' using errcode='22023'; end if;
end $$;

create function private.configure_client_operation_release(p_legacy jsonb,p_window jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(60182000::bigint);
 if not coalesce((select maintenance from private.release_write_control where singleton),false) then
  raise exception 'Enter maintenance before configuring release policies' using errcode='55000'; end if;
 update private.client_operation_policy set
  max_receipts=(p_legacy->>'max_receipts')::bigint,max_logical_bytes=(p_legacy->>'max_logical_bytes')::bigint,
  max_request_bytes=(p_legacy->>'max_request_bytes')::integer,max_result_bytes=(p_legacy->>'max_result_bytes')::integer,
  new_per_minute=(p_legacy->>'new_per_minute')::integer where singleton;
 update private.client_operation_window_policy set
  admission_seconds=(p_window->>'admission_seconds')::integer,replay_seconds=(p_window->>'replay_seconds')::integer,
  max_receipts=(p_window->>'max_receipts')::bigint,max_logical_bytes=(p_window->>'max_logical_bytes')::bigint,
  max_global_receipts=(p_window->>'max_global_receipts')::bigint,max_global_bytes=(p_window->>'max_global_bytes')::bigint,
  max_request_bytes=(p_window->>'max_request_bytes')::integer,max_result_bytes=(p_window->>'max_result_bytes')::integer,
  new_per_minute=(p_window->>'new_per_minute')::integer,
  legacy_admit_until=(p_window->>'legacy_admit_until')::timestamptz,legacy_replay_until=(p_window->>'legacy_replay_until')::timestamptz where singleton;
 perform private.assert_release_policies();
 if exists(select 1 from private.client_operation_budgets b cross join private.client_operation_policy p
  where b.receipt_count>p.max_receipts or b.logical_bytes+p.max_result_bytes+512>p.max_logical_bytes)
  or exists(select 1 from private.client_operation_live_budgets b cross join private.client_operation_window_policy p
   where b.receipt_count>case when b.scope='global' then p.max_global_receipts else p.max_receipts end
    or b.logical_bytes+p.max_result_bytes+512>case when b.scope='global' then p.max_global_bytes else p.max_logical_bytes end) then
  raise exception 'Configured policies cannot hold existing receipts and a new reservation' using errcode='22023'; end if;
end $$;

create function private.set_release_maintenance(p_enabled boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_enabled is null then raise exception 'Maintenance state required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(60182000::bigint);
 if not p_enabled then perform private.assert_release_policies(); end if;
 update private.release_write_control set maintenance=p_enabled where singleton;
end $$;
revoke all on function private.assert_release_policies(),private.configure_client_operation_release(jsonb,jsonb),private.set_release_maintenance(boolean)
 from public,anon,authenticated,service_role;

-- Multi-account bounded cleanup. The global budget is locked before account
-- rows, in the same order as admission/completion. A retired epoch admits no
-- new receipts, so each bounded ordered pass makes permanent progress.
alter table private.client_operation_epochs add column gc_touched_at timestamptz;
create or replace function private.prune_client_operation_receipts(p_generation uuid,p_epoch bigint,p_limit integer default 500) returns integer
language plpgsql security definer set search_path='' as $$
declare n integer; users uuid[];
begin
 if p_limit<1 or p_limit>5000 then raise exception 'Invalid batch size' using errcode='22023'; end if;
 perform pg_advisory_xact_lock_shared(60182001::bigint);
 perform pg_advisory_xact_lock(hashtextextended('tasktrace:v3:'||p_generation::text||':'||p_epoch::text,0));
 if not exists(select 1 from private.client_operation_epochs where generation=p_generation and epoch=p_epoch and state='retired') then
  raise exception 'Epoch not retired' using errcode='22023'; end if;
 perform 1 from private.client_operation_live_budgets where scope='global' for update;
 select array_agg(distinct user_id) into users from (
  select operation_id,user_id from private.client_operation_receipts_v3 where generation=p_generation and epoch=p_epoch
   order by user_id,operation_id limit p_limit
 ) candidates;
 if users is null then
  if not exists(select 1 from private.client_operation_epochs where generation=p_generation and epoch<p_epoch) then
   update private.client_operation_history set retired_through=greatest(retired_through,p_epoch) where singleton and generation=p_generation;
   delete from private.client_operation_epochs where generation=p_generation and epoch=p_epoch;
  end if;
  return 0;
 end if;
 perform 1 from private.client_operation_live_budgets where scope=any(select 'user:'||u::text from unnest(users) u) order by scope for update;
 with candidates as materialized (
  select ctid from private.client_operation_receipts_v3 where generation=p_generation and epoch=p_epoch
   order by user_id,operation_id limit p_limit
 ), deleted as (
  delete from private.client_operation_receipts_v3 r using candidates c where r.ctid=c.ctid returning r.user_id,r.accounted_bytes
 ), totals as (
  select 'user:'||user_id::text scope,count(*) n,sum(accounted_bytes) bytes from deleted group by user_id
  union all select 'global',count(*),coalesce(sum(accounted_bytes),0) from deleted
 ), accounted as (
  update private.client_operation_live_budgets b set receipt_count=b.receipt_count-t.n,logical_bytes=b.logical_bytes-t.bytes
   from totals t where b.scope=t.scope returning b.scope
 ) select count(*)::integer into n from deleted;
 delete from private.client_operation_live_budgets where scope=any(select 'user:'||u::text from unnest(users) u) and receipt_count=0;
 return n;
end $$;

create or replace function private.run_client_operation_lifecycle(p_batch integer default 500) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='20s' as $$
declare e record; n integer:=0; retired integer:=0; started timestamptz:=clock_timestamp();
begin
 if p_batch<1 or p_batch>5000 then raise exception 'Invalid batch size' using errcode='22023'; end if;
 perform private.advance_legacy_operation_lifecycle();
 for e in select generation,epoch from private.client_operation_epochs
  where state='retired' or replay_until<=private.operation_clock() or (state='open' and admit_until<=private.operation_clock())
  order by gc_touched_at nulls first,generation,epoch limit 8 loop
  exit when clock_timestamp()-started>interval '2 seconds';
  if private.retire_client_operation_epoch(e.generation,e.epoch) then retired:=retired+1; end if;
  if exists(select 1 from private.client_operation_epochs where generation=e.generation and epoch=e.epoch and state='retired') then
   n:=n+private.prune_client_operation_receipts(e.generation,e.epoch,p_batch);
  end if;
  update private.client_operation_epochs set gc_touched_at=clock_timestamp() where generation=e.generation and epoch=e.epoch;
 end loop;
 n:=n+private.prune_legacy_client_operation_receipts(p_batch);
 return jsonb_build_object('retired_epochs',retired,'deleted_receipts',n);
end $$;
notify pgrst,'reload schema';
commit;
