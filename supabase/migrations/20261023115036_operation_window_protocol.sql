begin;
set local lock_timeout='5s';
create function private.operation_clock() returns timestamptz language sql volatile set search_path='' as $$ select clock_timestamp() $$;
revoke all on function private.operation_clock() from public,anon,authenticated,service_role;

-- Values intentionally require an operator's measured configuration. Tests
-- install explicit laboratory limits; migration does not guess production SLA.
create table private.client_operation_window_policy (
 singleton boolean primary key default true check(singleton),
 admission_seconds integer check(admission_seconds>0), replay_seconds integer check(replay_seconds>60),
 max_receipts bigint check(max_receipts>0), max_logical_bytes bigint check(max_logical_bytes>0),
 max_global_receipts bigint check(max_global_receipts>0), max_global_bytes bigint check(max_global_bytes>0),
 max_request_bytes integer check(max_request_bytes>0), max_result_bytes integer check(max_result_bytes>0),
 new_per_minute integer check(new_per_minute>0),
 legacy_admit_until timestamptz, legacy_replay_until timestamptz,
 check(legacy_replay_until is null or (legacy_admit_until is not null and legacy_replay_until>legacy_admit_until))
);
insert into private.client_operation_window_policy(singleton) values(true);
create table private.client_operation_history (
 singleton boolean primary key default true check(singleton),
 generation uuid not null default gen_random_uuid(), current_epoch bigint not null default 0 check(current_epoch>=0),
 retired_through bigint not null default 0 check(retired_through>=0),
 legacy_closed boolean not null default false, legacy_retired boolean not null default false
);
insert into private.client_operation_history(singleton) values(true);
create table private.client_operation_epochs (
 generation uuid not null, epoch bigint not null check(epoch>0),
 admit_until timestamptz not null, replay_until timestamptz not null,
 state text not null default 'open' check(state in ('open','replay_only','retired')),
 primary key(generation,epoch), check(replay_until>admit_until)
);
create index client_operation_epochs_lifecycle on private.client_operation_epochs(state,replay_until,admit_until);
create table private.client_operation_live_budgets (
 scope text primary key, receipt_count bigint not null default 0 check(receipt_count>=0),
 logical_bytes bigint not null default 0 check(logical_bytes>=0),
 window_start timestamptz, window_count integer not null default 0 check(window_count>=0)
);
create table private.client_operation_receipts_v3 (
 generation uuid not null, epoch bigint not null, user_id uuid not null, operation_id uuid not null,
 operation_type text not null, target_id uuid not null,
 fingerprint_version smallint not null default 1 check(fingerprint_version=1),
 request_fingerprint bytea not null check(octet_length(request_fingerprint)=32),
 outcome jsonb, completed_at timestamptz, result_limit integer not null check(result_limit>0),
 accounted_bytes bigint not null check(accounted_bytes>=0), created_at timestamptz not null default private.operation_clock(),
 primary key(generation,epoch,user_id,operation_id),
 check((outcome is null)=(completed_at is null))
);
-- PK also serves ordered epoch/user cleanup; no redundant second full index.
alter table private.client_operation_window_policy enable row level security;
alter table private.client_operation_history enable row level security;
alter table private.client_operation_epochs enable row level security;
alter table private.client_operation_live_budgets enable row level security;
alter table private.client_operation_receipts_v3 enable row level security;
revoke all on private.client_operation_window_policy,private.client_operation_history,private.client_operation_epochs,
 private.client_operation_live_budgets,private.client_operation_receipts_v3 from public,anon,authenticated,service_role;

create function private.require_operation_account() returns uuid
language plpgsql security definer set search_path='' as $$
declare u uuid:=private.require_auth();
begin
 if not exists(select 1 from auth.users where id=u and deleted_at is null) then
  raise exception 'Account unavailable' using errcode='28000'; end if;
 return u;
end $$;

create function private.guard_operation_window() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_table_name='client_operation_epochs' then
  if (new.generation,new.epoch,new.admit_until,new.replay_until) is distinct from (old.generation,old.epoch,old.admit_until,old.replay_until)
    or (case new.state when 'open' then 0 when 'replay_only' then 1 else 2 end)<(case old.state when 'open' then 0 when 'replay_only' then 1 else 2 end) then
   raise exception 'Operation window cannot reopen or change deadlines' using errcode='22023'; end if;
 else
  if (old.legacy_closed and not new.legacy_closed) or (old.legacy_retired and not new.legacy_retired)
    or new.current_epoch<old.current_epoch or new.retired_through<old.retired_through then
   raise exception 'Operation history cannot rewind' using errcode='22023'; end if;
 end if;
 return new;
end $$;
create trigger operation_epoch_monotonic before update on private.client_operation_epochs for each row execute function private.guard_operation_window();
create trigger operation_history_monotonic before update on private.client_operation_history for each row execute function private.guard_operation_window();

-- Shared lineage fence precedes every epoch/budget/business lock. Rotation
-- exclusively fences all v3 transactions before changing the generation.
create function private.lock_operation_epoch(p_generation uuid,p_epoch bigint) returns text
language plpgsql security definer set search_path='' as $$
declare h private.client_operation_history%rowtype; e private.client_operation_epochs%rowtype; k bigint;
begin
 perform pg_advisory_xact_lock_shared(60182001::bigint);
 select * into h from private.client_operation_history where singleton;
 if p_generation is distinct from h.generation then return 'history_reset'; end if;
 if p_epoch is null or p_epoch<=0 then return 'invalid_epoch'; end if;
 k:=hashtextextended('tasktrace:v3:'||p_generation::text||':'||p_epoch::text,0);
 select * into e from private.client_operation_epochs where generation=p_generation and epoch=p_epoch;
 if not found then return case when p_epoch<=h.retired_through then 'expired' else 'invalid_epoch' end; end if;
 -- Choose exclusive BEFORE acquiring a shared lock: no competing lock upgrades.
 if (e.state='open' and private.operation_clock()>=e.admit_until) or (e.state<>'retired' and private.operation_clock()>=e.replay_until) then
  perform pg_advisory_xact_lock(k);
  update private.client_operation_epochs set state=case when private.operation_clock()>=replay_until then 'retired' else 'replay_only' end
   where generation=p_generation and epoch=p_epoch and state<>'retired';
 else perform pg_advisory_xact_lock_shared(k); end if;
 select * into e from private.client_operation_epochs where generation=p_generation and epoch=p_epoch;
 if not found or e.state='retired' then return 'expired'; end if;
 if private.operation_clock()>=e.replay_until then return 'window_closing'; end if;
 return e.state;
end $$;

create function public.get_client_operation_context() returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid:=private.require_operation_account(); p private.client_operation_window_policy%rowtype;
 h private.client_operation_history%rowtype; e private.client_operation_epochs%rowtype;
begin
 -- Short issuance transaction. Exclusive lineage fence avoids concurrent epoch
 -- allocation and drains old claims before closing the previous admission.
 perform pg_advisory_xact_lock(60182001::bigint);
 select * into p from private.client_operation_window_policy where singleton;
 if p.admission_seconds is null or p.replay_seconds is null or p.max_receipts is null or p.max_logical_bytes is null
  or p.max_global_receipts is null or p.max_global_bytes is null or p.max_request_bytes is null
  or p.max_result_bytes is null or p.new_per_minute is null then
  raise exception 'Operation windows require configuration' using errcode='PT503',detail='TT_RECEIPT_POLICY'; end if;
 select * into h from private.client_operation_history where singleton for update;
 select * into e from private.client_operation_epochs where generation=h.generation and epoch=h.current_epoch;
 if not found or e.state<>'open' or private.operation_clock()>=e.admit_until then
  update private.client_operation_epochs set state='replay_only' where generation=h.generation and epoch=h.current_epoch and state='open';
  update private.client_operation_history set current_epoch=current_epoch+1 where singleton returning * into h;
  insert into private.client_operation_epochs(generation,epoch,admit_until,replay_until)
   values(h.generation,h.current_epoch,private.operation_clock()+make_interval(secs=>p.admission_seconds),
    private.operation_clock()+make_interval(secs=>p.admission_seconds+p.replay_seconds)) returning * into e;
 end if;
 return jsonb_build_object('protocol_version',3,'fingerprint_version',1,'generation',h.generation,'epoch',e.epoch,
  'admit_until',e.admit_until,'replay_until',e.replay_until);
end $$;

create function private.claim_client_operation_v3(p_generation uuid,p_epoch bigint,p_operation_id uuid,p_type text,p_target uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=private.require_operation_account(); s text; r private.client_operation_receipts_v3%rowtype;
 p private.client_operation_window_policy%rowtype; b private.client_operation_live_budgets%rowtype;
 bytes bigint; w timestamptz; scopes text[]:=array['global','user:'||u::text]; e private.client_operation_epochs%rowtype;
begin
 if p_operation_id is null or p_type is null or p_target is null or p_payload is null then raise exception 'Invalid operation identity' using errcode='22023'; end if;
 s:=private.lock_operation_epoch(p_generation,p_epoch);
 if s not in ('open','replay_only') then return jsonb_build_object('state',s); end if;
 select * into r from private.client_operation_receipts_v3 where generation=p_generation and epoch=p_epoch and user_id=u and operation_id=p_operation_id;
 if not found then
  -- The closed epoch fence has drained every writer. An absent receipt is
  -- authoritative here and must not allocate idle per-user budget metadata.
  if s='replay_only' then return jsonb_build_object('state','not_applied'); end if;
  insert into private.client_operation_live_budgets(scope) select unnest(scopes) on conflict do nothing;
  -- Global then account budget. GC uses this same order and only one account
  -- per batch, so it cannot form a multi-account lock cycle.
  perform 1 from private.client_operation_live_budgets where scope=any(scopes) order by scope for update;
  select * into r from private.client_operation_receipts_v3 where generation=p_generation and epoch=p_epoch and user_id=u and operation_id=p_operation_id;
  if not found then
   select * into e from private.client_operation_epochs where generation=p_generation and epoch=p_epoch;
   -- Crossing a deadline while waiting must not admit a new command. A second
   -- resolver transaction persists the exclusive transition before not_applied.
   if private.operation_clock()>=e.admit_until then
    delete from private.client_operation_live_budgets where scope='user:'||u::text and receipt_count=0;
    return jsonb_build_object('state','window_closing');
   end if;
   select * into p from private.client_operation_window_policy where singleton;
   if p.max_receipts is null or p.max_logical_bytes is null or p.max_global_receipts is null or p.max_global_bytes is null
    or p.max_request_bytes is null or p.max_result_bytes is null or p.new_per_minute is null then
    raise exception 'Operation limits require configuration' using errcode='PT503',detail='TT_RECEIPT_POLICY'; end if;
   if octet_length(p_payload::text)>p.max_request_bytes then raise exception 'Operation request too large' using errcode='PT413',detail='TT_RECEIPT_LIMIT'; end if;
   bytes:=192+octet_length(p_type)+p.max_result_bytes;
   for b in select * from private.client_operation_live_budgets where scope=any(scopes) loop
    if b.receipt_count>=(case when b.scope='global' then p.max_global_receipts else p.max_receipts end)
     or b.logical_bytes+bytes>(case when b.scope='global' then p.max_global_bytes else p.max_logical_bytes end) then
     raise exception 'Live operation storage temporarily full' using errcode='PT507',detail='TT_RECEIPT_LIMIT'; end if;
   end loop;
   w:=date_trunc('minute',private.operation_clock());
   select * into b from private.client_operation_live_budgets where scope='user:'||u::text;
   if b.window_start=w and b.window_count>=p.new_per_minute then raise exception 'Operation rate limit' using errcode='PT429',detail='TT_RECEIPT_RATE'; end if;
   update private.client_operation_live_budgets set receipt_count=receipt_count+1,logical_bytes=logical_bytes+bytes,
    window_count=case when window_start=w then window_count+1 else 1 end,window_start=w where scope=any(scopes);
   insert into private.client_operation_receipts_v3(generation,epoch,user_id,operation_id,operation_type,target_id,request_fingerprint,result_limit,accounted_bytes)
    values(p_generation,p_epoch,u,p_operation_id,p_type,p_target,private.receipt_request_hash(p_type,p_target,p_payload),p.max_result_bytes,bytes);
   return jsonb_build_object('state','claimed');
  end if;
 end if;
 if (r.operation_type,r.target_id,r.request_fingerprint) is distinct from (p_type,p_target,private.receipt_request_hash(p_type,p_target,p_payload)) then
  raise exception 'operation_id reused with different request' using errcode='22023'; end if;
 if r.outcome is null then raise exception 'Operation receipt incomplete' using errcode='40001'; end if;
 return jsonb_build_object('state','completed','result',r.outcome);
end $$;

create function private.complete_client_operation_v3(p_generation uuid,p_epoch bigint,p_operation_id uuid,p_outcome jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare u uuid:=private.require_operation_account(); r private.client_operation_receipts_v3%rowtype; bytes bigint;
begin
 select * into strict r from private.client_operation_receipts_v3 where generation=p_generation and epoch=p_epoch and user_id=u and operation_id=p_operation_id for update;
 if r.outcome is not null then raise exception 'Completed operation is immutable' using errcode='22023'; end if;
 if p_outcome is null or octet_length(p_outcome::text)>r.result_limit then raise exception 'Operation result exceeds reservation' using errcode='PT507',detail='TT_RECEIPT_LIMIT'; end if;
 bytes:=192+octet_length(r.operation_type)+octet_length(p_outcome::text);
 update private.client_operation_live_budgets set logical_bytes=logical_bytes-r.accounted_bytes+bytes where scope in ('global','user:'||u::text);
 update private.client_operation_receipts_v3 set outcome=p_outcome,completed_at=private.operation_clock(),accounted_bytes=bytes
  where generation=p_generation and epoch=p_epoch and user_id=u and operation_id=p_operation_id;
end $$;

create function private.operation_protocol_reply(p_state text) returns jsonb
language plpgsql set search_path='' as $$
declare code text; status text;
begin
 code:=case p_state when 'expired' then 'TT_OPERATION_EXPIRED' when 'history_reset' then 'TT_OPERATION_HISTORY_RESET'
  when 'not_applied' then 'TT_OPERATION_NOT_APPLIED' when 'window_closing' then 'TT_OPERATION_WINDOW_CLOSING' else 'TT_OPERATION_INVALID_EPOCH' end;
 status:=case when p_state='expired' then '410' when p_state='invalid_epoch' then '400' else '409' end;
 perform set_config('response.status',status,true);
 return jsonb_build_object('code',code,'message','Operation requires resolution','details',code,'hint',null);
end $$;

create function private.replay_client_operation_v3(p_result jsonb,p_type text,p_target uuid,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare task uuid; value jsonb:=p_result->'value'; allowed boolean:=false; u uuid:=private.require_operation_account();
begin
 if p_type in ('set_task_item_state','set_task_item_percentage','set_task_item_comment') then
  select task_id into task from public.task_items where id=p_target;
  if task is null or not private.has_task_access(task,private.require_operation_account()) then
   return jsonb_build_object('state','result_redacted','terminal',true); end if;
 elsif jsonb_typeof(value) in ('object','array') and coalesce((p_result->>'http_status')::int,200)<400 and p_type<>'rpc:update_my_profile' then
  -- Payload is the fingerprint-verified ORIGINAL request. Reuse current ACL
  -- helpers for sensitive historical rows, rather than a second permission model.
  if p_payload->>'p_task_item_id' is not null then
   select task_id into task from public.task_items where id=(p_payload->>'p_task_item_id')::uuid;
   allowed:=task is not null and private.has_task_access(task,u);
  elsif p_payload->>'p_task_id' is not null then allowed:=private.has_task_access((p_payload->>'p_task_id')::uuid,u);
  elsif p_payload->>'p_project_id' is not null then allowed:=private.is_project_member((p_payload->>'p_project_id')::uuid,u);
  elsif p_payload->>'p_template_id' is not null then
   allowed:=exists(select 1 from public.task_templates where id=(p_payload->>'p_template_id')::uuid and created_by=u);
  elsif p_payload->>'p_item_id' is not null then
   allowed:=exists(select 1 from public.task_template_items i join public.task_templates t on t.id=i.template_id where i.id=(p_payload->>'p_item_id')::uuid and t.created_by=u);
  end if;
  if not coalesce(allowed,false) then return jsonb_build_object('state','result_redacted','terminal',true); end if;
 end if;
 return jsonb_build_object('state','completed','result',p_result);
end $$;

create function public.resolve_client_operation_v3(p_generation uuid,p_epoch bigint,p_operation_id uuid,p_type text,p_target uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=private.require_operation_account(); s text; r private.client_operation_receipts_v3%rowtype;
begin
 s:=private.lock_operation_epoch(p_generation,p_epoch);
 if s not in ('open','replay_only') then return jsonb_build_object('state',s); end if;
 -- Budget lock serializes missing-result checks with same-account claims.
 perform 1 from private.client_operation_live_budgets where scope='user:'||u::text for update;
 select * into r from private.client_operation_receipts_v3 where generation=p_generation and epoch=p_epoch and user_id=u and operation_id=p_operation_id;
 if not found then return jsonb_build_object('state',case when s='replay_only' then 'not_applied' else 'unknown' end); end if;
 if (r.operation_type,r.target_id,r.request_fingerprint) is distinct from (p_type,p_target,private.receipt_request_hash(p_type,p_target,p_payload)) then
  raise exception 'operation_id reused with different request' using errcode='22023'; end if;
 if r.outcome is null then return jsonb_build_object('state','unknown'); end if;
 return private.replay_client_operation_v3(r.outcome,r.operation_type,r.target_id,p_payload);
end $$;

-- Extract only the existing allowlisted business dispatcher. The legacy
-- wrapper, its receipts and HTTP-400/429 semantics remain unchanged.
do $migration$
declare definition text;
begin
 definition:=pg_get_functiondef('public.execute_client_mutation(uuid,text,jsonb)'::regprocedure);
 definition:=replace(definition,'public.execute_client_mutation(p_operation_id uuid, p_name text, p_args jsonb)','private.invoke_client_mutation_v3(p_operation_id uuid, p_name text, p_args jsonb)');
 definition:=regexp_replace(definition,'  select claimed,saved_result[\s\S]*?  select string_agg','  select string_agg');
 definition:=regexp_replace(definition,'  update private.client_operation_receipts[\s\S]*?  return v_result;','  return v_result;');
 if definition not like '%private.invoke_client_mutation_v3%' or definition like '%claim_client_operation(%' then raise exception 'Unexpected dispatcher definition'; end if;
 execute definition;
end $migration$;

create function public.execute_client_mutation_v3(p_generation uuid,p_epoch bigint,p_operation_id uuid,p_name text,p_args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare claim jsonb; value jsonb; outcome jsonb; status int; retry text; until_at timestamptz;
 msg text; detail text; hint text; err text;
begin
 perform private.require_operation_account();
 if p_name is null or p_name !~ '^[a-z][a-z0-9_]{0,95}$' or p_args is null or jsonb_typeof(p_args)<>'object' then
  raise exception 'Invalid mutation request' using errcode='22023'; end if;
 claim:=private.claim_client_operation_v3(p_generation,p_epoch,p_operation_id,'rpc:'||p_name,p_operation_id,p_args);
 if claim->>'state'='completed' then
  claim:=private.replay_client_operation_v3(claim->'result','rpc:'||p_name,p_operation_id,p_args);
  if claim->>'state'='result_redacted' then
   perform set_config('response.status','409',true);
   return jsonb_build_object('code','TT_OPERATION_RESULT_REDACTED','message','Operation completed; read current state','details','TT_OPERATION_RESULT_REDACTED');
  end if;
  outcome:=claim->'result'; value:=outcome->'value';
  perform set_config('response.status',coalesce(outcome->>'http_status','200'),true);
  if outcome->>'retry_after_until' is not null then
   perform set_config('response.headers',jsonb_build_array(jsonb_build_object('Retry-After',greatest(0,ceil(extract(epoch from (outcome->>'retry_after_until')::timestamptz-private.operation_clock())))::text))::text,true);
  end if;
  return value;
 elsif claim->>'state'<>'claimed' then return private.operation_protocol_reply(claim->>'state'); end if;
 begin
  value:=private.invoke_client_mutation_v3(p_operation_id,p_name,p_args);
 exception when sqlstate 'PT409' or sqlstate '22023' or sqlstate '23514' then
  get stacked diagnostics msg=message_text,detail=pg_exception_detail,hint=pg_exception_hint,err=returned_sqlstate;
  perform set_config('response.status',case when err='PT409' then '409' else '400' end,true);
  value:=jsonb_build_object('code',err,'message',msg,'details',nullif(detail,''),'hint',nullif(hint,''));
 end;
 status:=coalesce(nullif(current_setting('response.status',true),''),'200')::int;
 select h->>'Retry-After' into retry from jsonb_array_elements(coalesce(nullif(current_setting('response.headers',true),''),'[]')::jsonb) h where h?'Retry-After' limit 1;
 if retry~'^\d+$' then until_at:=private.operation_clock()+retry::int*interval '1 second'; end if;
 outcome:=jsonb_build_object('format_version',3,'value',value,'http_status',status,'retry_after_until',until_at);
 perform private.complete_client_operation_v3(p_generation,p_epoch,p_operation_id,outcome);
 return value;
end $$;

create function private.apply_task_item_operation_v3(p_generation uuid,p_epoch bigint,p_operation_id uuid,p_task_item_id uuid,p_expected_version bigint,p_kind text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare claim jsonb; task_id uuid; project_id uuid; project public.projects%rowtype; task public.tasks%rowtype;
 role public.project_role; item public.task_items%rowtype; result jsonb;
begin
 if p_expected_version is null or p_expected_version<1 or p_kind not in ('set_task_item_state','set_task_item_percentage','set_task_item_comment') then raise exception 'Invalid item operation' using errcode='22023'; end if;
 claim:=private.claim_client_operation_v3(p_generation,p_epoch,p_operation_id,p_kind,p_task_item_id,jsonb_build_object('payload',p_payload,'expected_version',p_expected_version));
 if claim->>'state'='completed' then
  claim:=private.replay_client_operation_v3(claim->'result',p_kind,p_task_item_id);
  if claim->>'state'='result_redacted' then return claim; end if;
  return claim->'result'->'value';
 elsif claim->>'state'<>'claimed' then return private.operation_protocol_reply(claim->>'state'); end if;
 perform set_config('tasktrace.write_protocol','3',true);
 select t.task_id into task_id from public.task_items t where id=p_task_item_id;
 if task_id is null then raise exception 'task item not found' using errcode='42501'; end if;
 project_id:=private.task_project_id(task_id); project:=private.lock_project_state(project_id); task:=private.lock_task(task_id);
 role:=private.lock_task_role(task_id,project_id,private.require_operation_account());
 select * into item from public.task_items where id=p_task_item_id for update;
 if item.id is null or item.task_id<>task_id or role is null or role not in ('owner','admin','member') or item.is_archived or task.status='archived' or project.status<>'active' then
  raise exception 'no access to active task item' using errcode='42501'; end if;
 if item.sync_version<>p_expected_version then
  result:=jsonb_build_object('status','conflict','version',item.sync_version,'item',to_jsonb(item));
 else
  if p_kind='set_task_item_state' then perform private.set_task_item_state_unchecked(p_task_item_id,(p_payload->>'completed')::boolean);
  elsif p_kind='set_task_item_percentage' then perform private.set_task_item_percentage_unchecked(p_task_item_id,(p_payload->>'percentage')::integer);
  else perform private.set_task_item_comment_unchecked(p_task_item_id,p_payload->>'comment'); end if;
  select * into item from public.task_items where id=p_task_item_id;
  if item.sync_version=p_expected_version then
   perform set_config('tasktrace.force_sync_version_bump','on',true);
   update public.task_items set sync_version=sync_version where id=p_task_item_id;
   perform set_config('tasktrace.force_sync_version_bump','off',true);
   select * into item from public.task_items where id=p_task_item_id;
  end if;
  result:=jsonb_build_object('status','applied','version',item.sync_version,'item',to_jsonb(item));
 end if;
 perform private.complete_client_operation_v3(p_generation,p_epoch,p_operation_id,jsonb_build_object('format_version',3,'value',result,'http_status',200));
 return result;
end $$;
create function public.apply_task_item_state_operation_v3(p_generation uuid,p_epoch bigint,p_operation_id uuid,p_task_item_id uuid,p_expected_version bigint,p_completed boolean) returns jsonb
language sql security definer set search_path='' as $$ select private.apply_task_item_operation_v3(p_generation,p_epoch,p_operation_id,p_task_item_id,p_expected_version,'set_task_item_state',jsonb_build_object('completed',p_completed)) $$;
create function public.apply_task_item_percentage_operation_v3(p_generation uuid,p_epoch bigint,p_operation_id uuid,p_task_item_id uuid,p_expected_version bigint,p_percentage integer) returns jsonb
language sql security definer set search_path='' as $$ select private.apply_task_item_operation_v3(p_generation,p_epoch,p_operation_id,p_task_item_id,p_expected_version,'set_task_item_percentage',jsonb_build_object('percentage',p_percentage)) $$;
create function public.apply_task_item_comment_operation_v3(p_generation uuid,p_epoch bigint,p_operation_id uuid,p_task_item_id uuid,p_expected_version bigint,p_comment text) returns jsonb
language sql security definer set search_path='' as $$ select private.apply_task_item_operation_v3(p_generation,p_epoch,p_operation_id,p_task_item_id,p_expected_version,'set_task_item_comment',jsonb_build_object('comment',p_comment)) $$;

-- Deny direct execution of all implementation functions, including dispatcher.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='private' and (p.proname like '%operation%v3' or p.proname in ('invoke_client_mutation_v3','require_operation_account','guard_operation_window','lock_operation_epoch','operation_protocol_reply')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
 end loop;
end $$;
revoke all on function public.get_client_operation_context(),public.execute_client_mutation_v3(uuid,bigint,uuid,text,jsonb),
 public.resolve_client_operation_v3(uuid,bigint,uuid,text,uuid,jsonb),
 public.apply_task_item_state_operation_v3(uuid,bigint,uuid,uuid,bigint,boolean),
 public.apply_task_item_percentage_operation_v3(uuid,bigint,uuid,uuid,bigint,integer),
 public.apply_task_item_comment_operation_v3(uuid,bigint,uuid,uuid,bigint,text) from public,anon,service_role;
grant execute on function public.get_client_operation_context(),public.execute_client_mutation_v3(uuid,bigint,uuid,text,jsonb),
 public.resolve_client_operation_v3(uuid,bigint,uuid,text,uuid,jsonb),
 public.apply_task_item_state_operation_v3(uuid,bigint,uuid,uuid,bigint,boolean),
 public.apply_task_item_percentage_operation_v3(uuid,bigint,uuid,uuid,bigint,integer),
 public.apply_task_item_comment_operation_v3(uuid,bigint,uuid,uuid,bigint,text) to authenticated;
notify pgrst,'reload schema';
commit;
