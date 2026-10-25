begin;
set local lock_timeout='5s';

create function private.guard_window_receipt() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' then
  if not exists(select 1 from private.client_operation_epochs where generation=old.generation and epoch=old.epoch and state='retired') then
   raise exception 'Live receipts cannot be deleted' using errcode='22023'; end if;
  return old;
 end if;
 if (new.generation,new.epoch,new.user_id,new.operation_id,new.operation_type,new.target_id,new.fingerprint_version,new.request_fingerprint,new.result_limit,new.created_at)
  is distinct from (old.generation,old.epoch,old.user_id,old.operation_id,old.operation_type,old.target_id,old.fingerprint_version,old.request_fingerprint,old.result_limit,old.created_at)
  or (old.outcome is not null and new is distinct from old) then
  raise exception 'Receipt identity and completed outcome are immutable' using errcode='22023'; end if;
 return new;
end $$;
create trigger operation_receipt_immutable before update or delete on private.client_operation_receipts_v3 for each row execute function private.guard_window_receipt();

create function private.retire_client_operation_epoch(p_generation uuid,p_epoch bigint) returns boolean
language plpgsql security definer set search_path='' as $$
declare retired boolean;
begin
 perform pg_advisory_xact_lock_shared(60182001::bigint);
 perform pg_advisory_xact_lock(hashtextextended('tasktrace:v3:'||p_generation::text||':'||p_epoch::text,0));
 update private.client_operation_epochs set state=case when replay_until<=private.operation_clock() then 'retired' else 'replay_only' end
  where generation=p_generation and epoch=p_epoch and state<>'retired'
   and (replay_until<=private.operation_clock() or (state='open' and admit_until<=private.operation_clock()))
  returning state='retired' into retired;
 return coalesce(retired,false);
end $$;
create function private.prune_client_operation_receipts(p_generation uuid,p_epoch bigint,p_limit integer default 500) returns integer
language plpgsql security definer set search_path='' as $$
declare u uuid; n integer; bytes bigint;
begin
 if p_limit<1 or p_limit>5000 then raise exception 'Invalid batch size' using errcode='22023'; end if;
 perform pg_advisory_xact_lock_shared(60182001::bigint);
 perform pg_advisory_xact_lock(hashtextextended('tasktrace:v3:'||p_generation::text||':'||p_epoch::text,0));
 if not exists(select 1 from private.client_operation_epochs where generation=p_generation and epoch=p_epoch and state='retired') then
  raise exception 'Epoch not retired' using errcode='22023'; end if;
 select user_id into u from private.client_operation_receipts_v3 where generation=p_generation and epoch=p_epoch order by user_id,operation_id limit 1;
 if u is null then
  -- Only advance the contiguous floor. Missing descriptors always fail closed,
  -- but this floor gives an explicit expired response for old compacted epochs.
  if not exists(select 1 from private.client_operation_epochs where generation=p_generation and epoch<p_epoch) then
   update private.client_operation_history set retired_through=greatest(retired_through,p_epoch) where singleton and generation=p_generation;
   delete from private.client_operation_epochs where generation=p_generation and epoch=p_epoch;
  end if;
  return 0;
 end if;
 perform 1 from private.client_operation_live_budgets where scope in ('global','user:'||u::text) order by scope for update;
 with deleted as (
  delete from private.client_operation_receipts_v3 where (generation,epoch,user_id,operation_id) in (
   select generation,epoch,user_id,operation_id from private.client_operation_receipts_v3
    where generation=p_generation and epoch=p_epoch and user_id=u order by operation_id limit p_limit
  ) returning accounted_bytes
 ) select count(*)::int,coalesce(sum(accounted_bytes),0) into n,bytes from deleted;
 update private.client_operation_live_budgets set receipt_count=receipt_count-n,logical_bytes=logical_bytes-bytes where scope in ('global','user:'||u::text);
 -- Idle/deleted users do not leave permanent per-user tombstones.
 delete from private.client_operation_live_budgets where scope='user:'||u::text and receipt_count=0;
 return n;
end $$;

create function private.advance_legacy_operation_lifecycle() returns void
language plpgsql security definer set search_path='' as $$
declare p private.client_operation_window_policy%rowtype;
begin
 perform pg_advisory_xact_lock_shared(60182001::bigint);
 perform pg_advisory_xact_lock(60182002::bigint);
 select * into p from private.client_operation_window_policy where singleton;
 update private.client_operation_history set legacy_closed=legacy_closed or (p.legacy_admit_until is not null and private.operation_clock()>=p.legacy_admit_until),
  legacy_retired=legacy_retired or (p.legacy_replay_until is not null and private.operation_clock()>=p.legacy_replay_until) where singleton;
end $$;

-- Inject the legacy fence into its single authoritative claim function. Every
-- v1/v2/generic receipt path calls this function, with its original fingerprint
-- and CAS semantics. Never rewrite historical migration files or UUIDs.
do $migration$
declare definition text;
begin
 definition:=pg_get_functiondef('private.claim_client_operation(uuid,text,uuid,jsonb)'::regprocedure);
 definition:=replace(definition,E'begin\n',E'begin\n  perform pg_advisory_xact_lock_shared(60182001::bigint);\n  perform pg_advisory_xact_lock_shared(60182002::bigint);\n  if (select legacy_retired from private.client_operation_history where singleton) then raise exception ''Legacy protocol retired'' using errcode=''PT410'',detail=''TT_OPERATION_EXPIRED''; end if;\n');
 definition:=replace(definition,E'  if not found then\n    -- One admission',E'  if not found then\n    if (select legacy_closed from private.client_operation_history where singleton) then raise exception ''Legacy admission closed'' using errcode=''PT409'',detail=''TT_OPERATION_NOT_APPLIED''; end if;\n    if exists(select 1 from private.client_operation_window_policy where legacy_admit_until<=private.operation_clock()) then raise exception ''Legacy window closing'' using errcode=''PT409'',detail=''TT_OPERATION_WINDOW_CLOSING''; end if;\n    -- One admission');
 definition:=replace(definition,'      insert into private.client_operation_receipts',
  E'      if exists(select 1 from private.client_operation_window_policy where legacy_admit_until<=private.operation_clock()) then raise exception ''Legacy window closing'' using errcode=''PT409'',detail=''TT_OPERATION_WINDOW_CLOSING''; end if;\n      insert into private.client_operation_receipts');
 definition:=replace(definition,E'begin\n',E'begin\n  perform private.require_operation_account();\n');
 definition:=replace(definition,'  return query select false,v_receipt.result_payload;',
  E'  if (private.replay_client_operation_v3(case when p_operation_type like ''rpc:%'' then v_receipt.result_payload else jsonb_build_object(''value'',v_receipt.result_payload,''http_status'',200) end,regexp_replace(p_operation_type,''_v2$'',''''),p_task_item_id,p_request_payload)->>''state'')=''result_redacted'' then raise exception ''Operation completed; result no longer accessible'' using errcode=''42501'',detail=''TT_OPERATION_RESULT_REDACTED''; end if;\n  return query select false,v_receipt.result_payload;');
 if definition not like '%TT_OPERATION_WINDOW_CLOSING%' then raise exception 'Unexpected legacy claim definition'; end if;
 execute definition;
 -- Completed legacy rows can only be removed after irreversible retirement.
 definition:=pg_get_functiondef('private.account_client_operation()'::regprocedure);
 definition:=replace(definition,'if old.completed_at is not null then raise exception',
  'if old.completed_at is not null and not (select legacy_retired from private.client_operation_history where singleton) then raise exception');
 execute definition;
end $migration$;

create function public.resolve_legacy_client_operation(p_operation_id uuid,p_type text,p_target uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=private.require_operation_account(); r private.client_operation_receipts%rowtype; h private.client_operation_history%rowtype; replay jsonb;
begin
 perform private.advance_legacy_operation_lifecycle();
 select * into h from private.client_operation_history where singleton;
 if h.legacy_retired then return jsonb_build_object('state','expired'); end if;
 perform 1 from private.client_operation_budgets where user_id=u for update;
 select * into r from private.client_operation_receipts where user_id=u and operation_id=p_operation_id;
 if not found then return jsonb_build_object('state',case when h.legacy_closed then 'not_applied' else 'unknown' end); end if;
 if (r.operation_type,r.task_item_id,r.request_fingerprint) is distinct from (p_type,p_target,private.receipt_request_hash(p_type,p_target,p_payload)) then
  raise exception 'operation_id reused with different request' using errcode='22023'; end if;
 if r.completed_at is null then return jsonb_build_object('state','unknown'); end if;
 replay:=private.replay_client_operation_v3(case when p_type like 'rpc:%' then r.result_payload
   else jsonb_build_object('value',r.result_payload,'http_status',200) end,regexp_replace(p_type,'_v2$',''),p_target,p_payload);
 if replay->>'state'='result_redacted' then return replay; end if;
 return jsonb_build_object('state','completed','result',r.result_payload);
end $$;
revoke all on function public.resolve_legacy_client_operation(uuid,text,uuid,jsonb) from public,anon,service_role;
grant execute on function public.resolve_legacy_client_operation(uuid,text,uuid,jsonb) to authenticated;

create function private.prune_legacy_client_operation_receipts(p_limit integer default 500) returns integer
language plpgsql security definer set search_path='' as $$
declare u uuid; n integer;
begin
 if p_limit<1 or p_limit>5000 then raise exception 'Invalid batch size' using errcode='22023'; end if;
 perform pg_advisory_xact_lock_shared(60182001::bigint);
 perform pg_advisory_xact_lock(60182002::bigint);
 if not (select legacy_retired from private.client_operation_history where singleton) then return 0; end if;
 select user_id into u from private.client_operation_receipts order by user_id,operation_id limit 1;
 if u is null then return 0; end if;
 perform 1 from private.client_operation_budgets where user_id=u for update;
 with deleted as (delete from private.client_operation_receipts where user_id=u and operation_id in (
  select operation_id from private.client_operation_receipts where user_id=u order by operation_id limit p_limit
 ) returning operation_id) select count(*)::int into n from deleted;
 delete from private.client_operation_budgets where user_id=u and receipt_count=0;
 return n;
end $$;

create function private.run_client_operation_lifecycle(p_batch integer default 500) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='20s' as $$
declare e record; n integer:=0; retired integer:=0;
begin
 perform private.advance_legacy_operation_lifecycle();
 for e in select generation,epoch from private.client_operation_epochs
  where state='retired' or replay_until<=private.operation_clock() or (state='open' and admit_until<=private.operation_clock())
  order by generation,epoch limit 8 loop
  -- Acquire EXCLUSIVE before inspecting/advancing the fence. Acquiring shared
  -- through a replay helper first would create cleaner lock-upgrade deadlocks.
  if private.retire_client_operation_epoch(e.generation,e.epoch) then retired:=retired+1; end if;
  if exists(select 1 from private.client_operation_epochs where generation=e.generation and epoch=e.epoch and state='retired') then
   n:=n+private.prune_client_operation_receipts(e.generation,e.epoch,p_batch);
  end if;
 end loop;
 n:=n+private.prune_legacy_client_operation_receipts(p_batch);
 return jsonb_build_object('retired_epochs',retired,'deleted_receipts',n);
end $$;

-- Restore runbook MUST fence external traffic before calling this routine.
-- A restored database alone cannot detect its own lost future. A fresh random
-- generation invalidates old handles; it is not a replacement for that fence.
create function private.rotate_client_operation_history() returns uuid
language plpgsql security definer set search_path='' as $$
declare g uuid:=gen_random_uuid();
begin
 perform pg_advisory_xact_lock(60182001::bigint);
 perform pg_advisory_xact_lock(60182002::bigint);
 update private.client_operation_epochs set state='retired' where state<>'retired';
 update private.client_operation_history set generation=g,legacy_closed=true,legacy_retired=true where singleton;
 return g;
end $$;

-- Lifecycle observability without exposing private rows to the Data API.
create view private.client_operation_lifecycle_status with(security_invoker=true) as
select e.generation,e.epoch,e.state,e.admit_until,e.replay_until,
 greatest(interval '0',private.operation_clock()-e.replay_until) as cleanup_lag,
 (select count(*) from private.client_operation_receipts_v3 r where r.generation=e.generation and r.epoch=e.epoch) as receipts
from private.client_operation_epochs e;
revoke all on private.client_operation_lifecycle_status from public,anon,authenticated,service_role;
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='private' and p.proname in ('guard_window_receipt','retire_client_operation_epoch','prune_client_operation_receipts',
 'advance_legacy_operation_lifecycle','prune_legacy_client_operation_receipts','run_client_operation_lifecycle','rotate_client_operation_history') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
 -- Match existing cron convention: an isolated database without pg_cron only
 -- installs the callable routine. No extension/host setting is changed here.
 if exists(select 1 from pg_extension where extname='pg_cron') then
  perform cron.schedule('tasktrace-operation-lifecycle','*/5 * * * *','set statement_timeout=''20s''; select private.run_client_operation_lifecycle(500)');
 end if;
end $$;
notify pgrst,'reload schema';
commit;
