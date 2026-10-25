\set ON_ERROR_STOP on
begin;
-- Entire suite, including laboratory policy and clock changes, rolls back.
insert into auth.users(id,email,raw_user_meta_data) values
 ('a23f0000-0000-4000-8000-000000000001','operation-window-sql@test.local','{}');
update private.client_operation_window_policy set max_receipts=1;
do $$ declare relation text; begin
 foreach relation in array array['client_operation_history','client_operation_epochs','client_operation_window_policy','client_operation_live_budgets','client_operation_receipts_v3'] loop
  if has_table_privilege('authenticated','private.'||relation,'SELECT,INSERT,UPDATE,DELETE')
   or has_table_privilege('anon','private.'||relation,'SELECT')
   or not (select relrowsecurity from pg_class where oid=('private.'||relation)::regclass) then raise exception 'Private operation state exposed: %',relation; end if;
 end loop;
 if has_function_privilege('authenticated','private.claim_client_operation_v3(uuid,bigint,uuid,text,uuid,jsonb)','EXECUTE')
  or has_function_privilege('authenticated','private.run_client_operation_lifecycle(integer)','EXECUTE')
  or has_function_privilege('authenticated','private.invoke_client_mutation_v3(uuid,text,jsonb)','EXECUTE')
  or has_function_privilege('anon','public.get_client_operation_context()','EXECUTE') then raise exception 'Operation helper exposed'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','a23f0000-0000-4000-8000-000000000001',true);
do $$ declare c jsonb; first jsonb; replay jsonb; begin
 c:=public.get_client_operation_context();
 perform set_config('tasktrace.test_window_context',c::text,true);
 first:=public.execute_client_mutation_v3((c->>'generation')::uuid,(c->>'epoch')::bigint,
  'a23f0000-0000-4000-8000-000000000010','create_project','{"p_name":"SQL v3 contract"}');
 replay:=public.execute_client_mutation_v3((c->>'generation')::uuid,(c->>'epoch')::bigint,
  'a23f0000-0000-4000-8000-000000000010','create_project','{"p_name":"SQL v3 contract"}');
 if first is distinct from replay then raise exception 'v3 replay changed'; end if;
 begin
  perform public.execute_client_mutation_v3((c->>'generation')::uuid,(c->>'epoch')::bigint,
   'a23f0000-0000-4000-8000-000000000010','create_project','{"p_name":"Changed payload"}');
  raise exception 'Changed payload accepted';
 exception when sqlstate '22023' then null; end;
 begin
  perform public.execute_client_mutation_v3((c->>'generation')::uuid,(c->>'epoch')::bigint,
   'a23f0000-0000-4000-8000-000000000020','create_project','{"p_name":"SQL v3 admission recovered"}');
  raise exception 'Full budget accepted admission';
 exception when sqlstate 'PT507' then null; end;
end $$;
reset role;
do $$ declare c jsonb:=current_setting('tasktrace.test_window_context')::jsonb; deadline timestamptz; begin
 deadline:=(c->>'admit_until')::timestamptz+interval '1 second';
 execute format('create or replace function private.operation_clock() returns timestamptz language sql volatile set search_path='''' as %L',format('select %L::timestamptz',deadline));
 perform private.run_client_operation_lifecycle(1);
 if (select state from private.client_operation_epochs where generation=(c->>'generation')::uuid and epoch=(c->>'epoch')::bigint)<>'replay_only' then raise exception 'Lifecycle failed to close admission'; end if;
 execute format('create or replace function private.operation_clock() returns timestamptz language sql volatile set search_path='''' as %L','select clock_timestamp()');
 perform private.run_client_operation_lifecycle(1);
 if (select state from private.client_operation_epochs where generation=(c->>'generation')::uuid and epoch=(c->>'epoch')::bigint)<>'replay_only' then raise exception 'Clock rollback reopened admission'; end if;
end $$;
do $$ declare c jsonb:=current_setting('tasktrace.test_window_context')::jsonb; deadline timestamptz; begin
 if (select count(*) from private.client_operation_receipts_v3 where user_id='a23f0000-0000-4000-8000-000000000001')<>1 then raise exception 'Unexpected receipt count'; end if;
 begin
  delete from private.client_operation_receipts_v3 where user_id='a23f0000-0000-4000-8000-000000000001';
  raise exception 'Live receipt deleted';
 exception when sqlstate '22023' then null; end;
 deadline:=(c->>'replay_until')::timestamptz+interval '1 second';
 execute format('create or replace function private.operation_clock() returns timestamptz language sql volatile set search_path='''' as %L',format('select %L::timestamptz',deadline));
 perform private.retire_client_operation_epoch((c->>'generation')::uuid,(c->>'epoch')::bigint);
 perform private.prune_client_operation_receipts((c->>'generation')::uuid,(c->>'epoch')::bigint,500);
 if (select receipt_count from private.client_operation_live_budgets where scope='global')<>0 then raise exception 'GC did not release budget'; end if;
end $$;
set local role authenticated;
do $$ declare c jsonb:=current_setting('tasktrace.test_window_context')::jsonb; result jsonb; next_context jsonb; begin
 result:=public.execute_client_mutation_v3((c->>'generation')::uuid,(c->>'epoch')::bigint,
  'a23f0000-0000-4000-8000-000000000010','create_project','{"p_name":"SQL v3 contract"}');
 if result->>'code'<>'TT_OPERATION_EXPIRED' then raise exception 'Old ID was not rejected'; end if;
 next_context:=public.get_client_operation_context();
 result:=public.execute_client_mutation_v3((next_context->>'generation')::uuid,(next_context->>'epoch')::bigint,
  'a23f0000-0000-4000-8000-000000000020','create_project','{"p_name":"SQL v3 admission recovered"}');
 if jsonb_typeof(result)<>'string' then raise exception 'Admission did not recover after GC'; end if;
end $$;
reset role;
do $$begin
 if (select count(*) from public.projects where name='SQL v3 contract')<>1
  or (select count(*) from public.projects where name='SQL v3 admission recovered')<>1 then raise exception 'Duplicate or missing business effect'; end if;
end $$;
rollback;
