-- Diagnostic-only ingress. No business RPC, role, outbox or sync protocol changes.
begin;
set local lock_timeout = '3s';

create table public.client_error_logs (
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid not null,
  received_at timestamptz not null default clock_timestamp(),
  occurred_at timestamptz not null,
  app_version text not null,
  app_build text not null,
  kind text not null,
  operation text not null,
  stage text not null,
  description text not null,
  fingerprint text not null,
  event jsonb not null,
  primary key(user_id,event_id)
);
alter table public.client_error_logs enable row level security;
revoke all on public.client_error_logs from public,anon,authenticated,service_role;
grant select on public.client_error_logs to service_role;
create index client_error_logs_user_time on public.client_error_logs(user_id,received_at desc);
create index client_error_logs_retention on public.client_error_logs(received_at);
comment on table public.client_error_logs is 'Allowlisted client errors only; no client reads or direct writes. Ingested through a verified server context; 20/user/UTC day, 4096 serialized bytes, 14 day retention.';

create function private.client_error_keys(p_value jsonb,p_keys text[]) returns boolean
language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p_value) is distinct from 'object' then return false; end if;
 return (select count(*)=cardinality(p_keys) and coalesce(bool_and(k=any(p_keys)),false) from jsonb_object_keys(p_value) k);
end $$;
create function private.client_error_integer(p_value jsonb,p_max numeric,p_min numeric default 0) returns boolean
language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p_value) is distinct from 'number' then return false; end if;
 return (p_value::text)::numeric between p_min and p_max and trunc((p_value::text)::numeric)=(p_value::text)::numeric;
exception when others then return false;
end $$;

create function private.valid_client_error_event(p jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare e jsonb; c jsonb; f jsonb; k text;
 kinds constant text[]:=array['local_data','outbox_blocked','conflict','permission','server','session','storage','storage_full','write_disabled','unknown'];
 stages constant text[]:=array['ui','identity','version','capabilities','outbox','enqueue','snapshot_recovery','storage_open','storage_read','storage_write','cache_read','cache_write','sync_auth','sync_context','sync_send','sync_ack','sync_reconcile','mutation','service_worker','unhandled'];
 ops constant text[]:=array['set_task_item_state','set_task_item_percentage','set_task_item_comment','sync','mutation','unknown'];
 names constant text[]:=array['Error','OperationError','TypeError','RangeError','SyntaxError','DOMException','QuotaExceededError','VersionError','InvalidStateError','NotReadableError','UnknownError','DataError','TransactionInactiveError','ConstraintError','SecurityError','DataCloneError','ReadOnlyError','NotFoundError','NotSupportedError','NetworkError','AbortError','TimeoutError','AuthSessionMissingError','AuthSessionUnavailableError','ResourceAccessDeniedError','ServiceUnavailableError','MutationOutcomeUnknownError','SupersededReadError','UnknownException'];
 codes constant text[]:=array['NONE','OTHER','42501','PT409','PT426','PT429','PT503','22023','23505','23514','22P02','P0001','28000','28P01','PGRST000','PGRST116','PGRST202','PGRST301','PGRST303','SQLITE_FULL','TT_LOCAL_SNAPSHOT_MISSING','TT_LOCAL_SNAPSHOT_INVALID','TT_LOCAL_VERSION','TT_OUTBOX_BLOCKED','TT_SESSION','TT_CAPABILITIES','TT_WRITE_DISABLED','TT_STORAGE','TT_STORAGE_FULL','TT_OPERATION_CONTEXT','TT_OPERATION_EXPIRED','TT_OPERATION_HISTORY_RESET','TT_OPERATION_RESULT_REDACTED','TT_OPERATION_HANDLE_MISSING','TT_OPERATION_LEGACY_REVIEW','TT_OPERATION_NOT_APPLIED','TT_OPERATION_WINDOW_CLOSING','TT_MUTATION_RECONCILED','TT_MUTATION_PENDING','TT_MUTATION_STORAGE','LOCAL_STORAGE','session_expired','refresh_token_not_found','refresh_token_already_used'];
 modules constant text[]:=array['edit','outbox','sync','cache','repository','runtime-config','driver.web','driver.native','mutation','user-message','web_bundle','native_bundle'];
begin
 if not private.client_error_keys(p,array['schema_version','event_id','occurred_at','app_version','app_build','protocol_version','sw_version','kind','operation','stage','error','connection','network_issue','capabilities','cache','outbox','displayed_version','server_version']) then return false; end if;
 if p->'schema_version'<>'1'::jsonb or p->'protocol_version'<>'3'::jsonb then return false; end if;
 if jsonb_typeof(p->'event_id')<>'string' or p->>'event_id'!~*'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' then return false; end if;
 if jsonb_typeof(p->'occurred_at')<>'string' or p->>'occurred_at'!~'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' then return false; end if;
 perform (p->>'occurred_at')::timestamptz;
 if jsonb_typeof(p->'app_version')<>'string' or p->>'app_version'!~'^\d{1,3}\.\d{1,3}\.\d{1,3}$'
  or jsonb_typeof(p->'app_build')<>'string' or p->>'app_build'!~'^(?:[a-f0-9]{7,64}|unknown|development)$' then return false; end if;
 if p->'sw_version'<>'null'::jsonb and (jsonb_typeof(p->'sw_version')<>'string' or p->>'sw_version'!~'^[a-f0-9]{16,64}$') then return false; end if;
 if not coalesce(p->>'kind'=any(kinds),false) or not coalesce(p->>'stage'=any(stages),false) or not coalesce(p->>'operation'=any(ops),false)
  or not coalesce(p->>'connection'=any(array['online','offline','degraded']),false) then return false; end if;
 if p->'network_issue'<>'null'::jsonb and not coalesce(p->>'network_issue'=any(array['network','auth-service','data-service','authorization']),false) then return false; end if;
 if p->'displayed_version'<>'null'::jsonb and not private.client_error_integer(p->'displayed_version',9007199254740991,1) then return false; end if;
 if p->'server_version'<>'null'::jsonb and not private.client_error_integer(p->'server_version',9007199254740991,1) then return false; end if;
 e:=p->'error';
 if not private.client_error_keys(e,array['name','code','causes','frames']) or not coalesce(e->>'name'=any(names),false) or not coalesce(e->>'code'=any(codes),false)
  or jsonb_typeof(e->'causes') is distinct from 'array' or jsonb_typeof(e->'frames') is distinct from 'array' then return false; end if;
 if jsonb_array_length(e->'causes')>3 or jsonb_array_length(e->'frames')>6 then return false; end if;
 for c in select * from jsonb_array_elements(e->'causes') loop
  if not private.client_error_keys(c,array['name','code']) or not coalesce(c->>'name'=any(names),false) or not coalesce(c->>'code'=any(codes),false) then return false; end if;
 end loop;
 for f in select * from jsonb_array_elements(e->'frames') loop
  if not private.client_error_keys(f,array['module','line','column']) or not coalesce(f->>'module'=any(modules),false)
   or not private.client_error_integer(f->'line',100000000) or not private.client_error_integer(f->'column',100000000) then return false; end if;
 end loop;
 c:=p->'capabilities';
 if c<>'null'::jsonb then
  if not private.client_error_keys(c,array['write','sync','available']) then return false; end if;
  foreach k in array array['write','sync','available'] loop if jsonb_typeof(c->k) is distinct from 'boolean' then return false; end if; end loop;
 end if;
 c:=p->'cache';
 if c<>'null'::jsonb then
  if not private.client_error_keys(c,array['snapshot','version']) or not coalesce(c->>'snapshot'=any(array['valid','missing','invalid','unavailable']),false)
   or (c->'version'<>'null'::jsonb and not private.client_error_integer(c->'version',9007199254740991,1)) then return false; end if;
 end if;
 c:=p->'outbox';
 if c<>'null'::jsonb then
  if not private.client_error_keys(c,array['pending','failed','conflict','review','acknowledged','dependent']) or jsonb_typeof(c->'dependent') is distinct from 'boolean' then return false; end if;
  foreach k in array array['pending','failed','conflict','review','acknowledged'] loop if not private.client_error_integer(c->k,100000) then return false; end if; end loop;
 end if;
 return octet_length(convert_to(p::text,'UTF8'))<=4096;
exception when others then return false;
end $$;

-- Only the trusted Edge DB connection can call this helper. User identity is
-- supplied ONLY after Auth /user verification, never read from the event body.
create function private.ingest_client_error(p_user_id uuid,p_event jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare t timestamptz:=clock_timestamp(); cutoff timestamptz; signature text; v_log public.client_error_logs%rowtype;
begin
 if p_user_id is null or not exists(select 1 from auth.users where id=p_user_id and deleted_at is null) then return 'account_unavailable'; end if;
 if not private.valid_client_error_event(p_event) then return 'invalid'; end if;
 v_log.user_id:=p_user_id; v_log.event_id:=(p_event->>'event_id')::uuid; v_log.received_at:=t; v_log.occurred_at:=(p_event->>'occurred_at')::timestamptz;
 if v_log.occurred_at<t-interval '14 days' or v_log.occurred_at>t+interval '5 minutes' then return 'invalid'; end if;
 v_log.app_version:=p_event->>'app_version'; v_log.app_build:=p_event->>'app_build'; v_log.kind:=p_event->>'kind'; v_log.operation:=p_event->>'operation'; v_log.stage:=p_event->>'stage'; v_log.event:=p_event;
 v_log.description:=case v_log.kind when 'local_data' then 'Confirmed local data missing or invalid' when 'outbox_blocked' then 'Previous operation requires reconciliation'
  when 'conflict' then 'Version conflict' when 'permission' then 'Permission denied' when 'server' then 'Server or capabilities unavailable'
  when 'session' then 'Session unavailable or expired' when 'storage' then 'Local storage failure' when 'storage_full' then 'Local storage quota exhausted'
  when 'write_disabled' then 'Local writes disabled' else 'Unclassified client exception' end;
 signature:=md5(jsonb_build_array(v_log.app_build,v_log.kind,v_log.operation,v_log.stage,p_event#>>'{error,name}',p_event#>>'{error,code}',p_event#>'{error,causes}',p_event#>'{error,frames}',p_event#>>'{cache,snapshot}',p_event->>'connection',p_event->>'network_issue',p_event->'capabilities')::text);
 v_log.fingerprint:=signature;
 -- Bound the actual serialized FULL stored event, including server metadata.
 if octet_length(convert_to(to_jsonb(v_log)::text,'UTF8'))>4096 then return 'invalid'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,60182801));
 if exists(select 1 from public.client_error_logs where user_id=p_user_id and event_id=v_log.event_id) then return 'duplicate'; end if;
 if exists(select 1 from public.client_error_logs where user_id=p_user_id and received_at>t-interval '15 minutes' and fingerprint=signature) then return 'duplicate'; end if;
 cutoff:=date_trunc('day',t at time zone 'UTC') at time zone 'UTC';
 if (select count(*) from public.client_error_logs where user_id=p_user_id and received_at>=cutoff)>=20 then return 'quota'; end if;
 if exists(select 1 from public.client_error_logs where user_id=p_user_id and received_at>t-interval '30 seconds') then return 'rate_limited'; end if;
 insert into public.client_error_logs select v_log.*;
 return 'accepted';
end $$;

create function private.cleanup_client_error_logs(p_limit integer default 10000) returns integer
language plpgsql security definer set search_path='' as $$
declare removed integer;
begin
 if p_limit<1 or p_limit>10000 or p_limit is null then raise exception 'Invalid diagnostic cleanup batch' using errcode='22023'; end if;
 delete from public.client_error_logs where (user_id,event_id) in
  (select user_id,event_id from public.client_error_logs where received_at<clock_timestamp()-interval '14 days' order by received_at limit p_limit for update skip locked);
 get diagnostics removed=row_count;
 return removed;
end $$;

revoke all on function private.client_error_keys(jsonb,text[]),private.client_error_integer(jsonb,numeric,numeric),private.valid_client_error_event(jsonb),private.ingest_client_error(uuid,jsonb),private.cleanup_client_error_logs(integer) from public,anon,authenticated,service_role;
do $$begin
 if exists(select 1 from pg_extension where extname='pg_cron') then
  perform cron.schedule('tasktrace-client-error-retention','43 * * * *','set statement_timeout=''10s''; select private.cleanup_client_error_logs(10000)');
 end if;
end $$;
commit;
