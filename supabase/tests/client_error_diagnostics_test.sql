\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('a28f0000-0000-4000-8000-000000000001','diagnostic-one@test.local','{"display_name":"Diagnostic one"}'),
 ('a28f0000-0000-4000-8000-000000000002','diagnostic-two@test.local','{"display_name":"Diagnostic two"}');

create function pg_temp.diagnostic_event() returns jsonb language sql as $$
 select jsonb_build_object('schema_version',1,'event_id',gen_random_uuid(),'occurred_at',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'app_version','1.0.0','app_build','abcdef12','protocol_version',3,'sw_version',null,'kind','local_data','operation','set_task_item_state','stage','enqueue',
 'error',jsonb_build_object('name','OperationError','code','TT_LOCAL_SNAPSHOT_MISSING','causes','[]'::jsonb,'frames','[]'::jsonb),
 'connection','degraded','network_issue','data-service','capabilities',jsonb_build_object('write',true,'sync',true,'available',true),
 'cache',jsonb_build_object('snapshot','missing','version',null),
 'outbox',jsonb_build_object('pending',0,'failed',0,'conflict',0,'review',0,'acknowledged',0,'dependent',false),'displayed_version',1,'server_version',null)
$$;

do $$
declare u uuid:='a28f0000-0000-4000-8000-000000000001'; e jsonb:=pg_temp.diagnostic_event(); bad jsonb; k text; original public.client_error_logs%rowtype;
begin
 if not private.valid_client_error_event(e) then raise exception 'Valid diagnostic rejected'; end if;
 if private.ingest_client_error(u,e)<>'accepted' then raise exception 'First ingest failed'; end if;
 if private.ingest_client_error(u,e)<>'duplicate' then raise exception 'Lost ACK retry duplicated a diagnostic'; end if;
 if private.ingest_client_error(u,pg_temp.diagnostic_event())<>'duplicate' then raise exception 'Fingerprint dedup failed'; end if;
 if private.ingest_client_error(u,jsonb_set(pg_temp.diagnostic_event(),'{operation}','"set_task_item_percentage"'))<>'rate_limited' then raise exception 'Server rate limit bypassed'; end if;
 if (select count(*) from public.client_error_logs where user_id=u)<>1 then raise exception 'Rate/dedup inserted extra rows'; end if;
 if private.ingest_client_error('a28f0000-0000-4000-8000-000000000002',e)<>'accepted' then raise exception 'Separate account cannot report same event ID'; end if;
 foreach k in array array['user_id','access_token','refresh_token','password','comment','headers','request','payload','stack'] loop
  if private.ingest_client_error(u,e||jsonb_build_object(k,'CONFIDENTIAL_CANARY'))<>'invalid' then raise exception 'Top-level secret accepted: %',k; end if;
 end loop;
 foreach bad in array array[
  jsonb_set(e,'{error}',(e->'error')||'{"message":"CONFIDENTIAL_CANARY"}'),
  jsonb_set(e,'{cache}',(e->'cache')||'{"data":"CONFIDENTIAL_CANARY"}'),
  jsonb_set(e,'{outbox}',(e->'outbox')||'{"payload":"CONFIDENTIAL_CANARY"}'),
  jsonb_set(e,'{error,causes}','[{"name":"Error","code":"NONE","token":"CONFIDENTIAL_CANARY"}]'),
  jsonb_set(e,'{error,frames}','[{"module":"web_bundle","line":1,"column":1,"url":"CONFIDENTIAL_CANARY"}]'),
  jsonb_set(e,'{kind}','"activity"'),jsonb_set(e,'{capabilities,write}','"true"'),
  jsonb_set(e,'{displayed_version}','9007199254740992'),jsonb_set(e,'{outbox,pending}','-1'),
  e||jsonb_build_object('padding',repeat('я',4096))
 ] loop
  if private.valid_client_error_event(bad) or private.ingest_client_error(u,bad)<>'invalid' then raise exception 'Invalid/nested diagnostic accepted'; end if;
 end loop;
 if private.ingest_client_error(u,jsonb_set(e,'{occurred_at}',to_jsonb(to_char((clock_timestamp()-interval '15 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))<>'invalid' then raise exception 'Expired client event accepted'; end if;
 if exists(select 1 from public.client_error_logs l where octet_length(convert_to(to_jsonb(l)::text,'UTF8'))>4096 or l::text like '%CONFIDENTIAL_CANARY%') then raise exception 'Stored event exceeds limit or leaks secret'; end if;
 select * into original from public.client_error_logs where user_id=u limit 1;
 delete from public.client_error_logs where user_id=u;
 for i in 1..20 loop
  original.event_id:=gen_random_uuid(); original.received_at:=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'; original.fingerprint:=md5(i::text);
  insert into public.client_error_logs select original.*;
 end loop;
 if private.ingest_client_error(u,jsonb_set(pg_temp.diagnostic_event(),'{stage}','"ui"'))<>'quota' then raise exception '20/day server quota bypassed'; end if;
 if (select count(*) from public.client_error_logs where user_id=u)<>20 then raise exception 'Quota changed stored diagnostics'; end if;
 if not (select relrowsecurity from pg_class where oid='public.client_error_logs'::regclass) then raise exception 'RLS disabled'; end if;
 if exists(select 1 from pg_publication_tables where schemaname='public' and tablename='client_error_logs') then raise exception 'Diagnostics use Realtime'; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','a28f0000-0000-4000-8000-000000000001',true);
do $$begin
 begin perform * from public.client_error_logs; raise exception 'User read own/foreign diagnostics'; exception when insufficient_privilege then null; end;
 begin delete from public.client_error_logs; raise exception 'User deleted diagnostics'; exception when insufficient_privilege then null; end;
 begin update public.client_error_logs set kind='unknown'; raise exception 'User changed diagnostics'; exception when insufficient_privilege then null; end;
 begin perform private.ingest_client_error('a28f0000-0000-4000-8000-000000000002','{}'); raise exception 'User forged another identity'; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$
declare r text; removed integer; old_count integer;
begin
 foreach r in array array['anon','authenticated'] loop
  if has_table_privilege(r,'public.client_error_logs','SELECT,INSERT,UPDATE,DELETE') or has_function_privilege(r,'private.ingest_client_error(uuid,jsonb)','EXECUTE')
   or has_function_privilege(r,'private.cleanup_client_error_logs(integer)','EXECUTE') then raise exception 'Client diagnostic ACL opened for %',r; end if;
 end loop;
 if has_table_privilege('service_role','public.client_error_logs','INSERT,UPDATE,DELETE') then raise exception 'Service role unexpectedly has direct writes'; end if;
 update public.client_error_logs set received_at=clock_timestamp()-interval '15 days' where user_id='a28f0000-0000-4000-8000-000000000001';
 select count(*) into old_count from public.client_error_logs where received_at<clock_timestamp()-interval '14 days';
 removed:=private.cleanup_client_error_logs(5);
 if removed<>5 then raise exception 'Cleanup batch bound failed'; end if;
 removed:=private.cleanup_client_error_logs();
 if removed<>old_count-5 then raise exception 'Retention did not remove old rows'; end if;
 if (select count(*) from public.client_error_logs)<>1 then raise exception 'Retention removed fresh diagnostics'; end if;
 begin perform private.cleanup_client_error_logs(10001); raise exception 'Unbounded cleanup allowed'; exception when invalid_parameter_value then null; end;
end $$;
rollback;
