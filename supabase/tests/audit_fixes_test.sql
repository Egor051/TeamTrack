\set ON_ERROR_STOP on
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('a22f0000-0000-4000-8000-000000000001','audit-fixes-sql@test.local','{"display_name":"Audit SQL"}');

do $$
declare v_table text;
begin
  foreach v_table in array array['task_item_snapshot_revisions','client_operation_policy','client_operation_budgets'] loop
    if has_table_privilege('authenticated','private.'||v_table,'SELECT,INSERT,UPDATE,DELETE')
      or has_table_privilege('anon','private.'||v_table,'SELECT')
      or not (select relrowsecurity from pg_class where oid=('private.'||v_table)::regclass) then
      raise exception 'Private audit state is exposed: %',v_table;
    end if;
  end loop;
  if has_function_privilege('authenticated','private.receipt_request_hash(text,uuid,jsonb)','EXECUTE')
    or has_function_privilege('anon','private.account_client_operation()','EXECUTE') then
    raise exception 'Private receipt helper is exposed';
  end if;
  if private.receipt_request_hash('x',null,'{"n":1.0,"a":[{"z":-0.00},2.000]}')
    <>private.receipt_request_hash('x',null,'{"a":[{"z":0},2],"n":1}') then
    raise exception 'JSONB numeric/object equality changed';
  end if;
  if private.receipt_request_hash('x',null,'{}')=private.receipt_request_hash('x',null,'{"n":null}')
    or private.receipt_request_hash('x',null,'[1,2]')=private.receipt_request_hash('x',null,'[2,1]')
    or private.receipt_request_hash('x',null,'{}')=private.receipt_request_hash('y',null,'{}') then
    raise exception 'Fingerprint lost request identity';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','a22f0000-0000-4000-8000-000000000001',true);
select public.create_project('Audit snapshot SQL','') as project \gset
select public.create_task(:'project','Target','active') as task \gset
select public.create_task(:'project','Foreign','active') as foreign_task \gset
select set_config('tasktrace.audit_task',:'task',true),set_config('tasktrace.audit_foreign',:'foreign_task',true);

do $$
declare v_task uuid:=current_setting('tasktrace.audit_task')::uuid; v_page jsonb; v_current jsonb;
begin
  v_page:=public.get_task_item_snapshot_page(v_task);
  perform public.create_task_item(current_setting('tasktrace.audit_foreign')::uuid,'Unrelated');
  v_current:=public.get_task_item_snapshot_page(v_task,p_revision=>(v_page->>'revision')::bigint);
  if (v_current->>'total')::int<>0 or v_current->'rows'<>'[]'::jsonb then raise exception 'Empty snapshot changed'; end if;
  perform public.create_task_item(v_task,'Target write');
  begin
    perform public.get_task_item_snapshot_page(v_task,p_revision=>(v_page->>'revision')::bigint);
    raise exception 'Target change accepted an obsolete revision';
  exception when sqlstate 'PT409' then null; end;
  v_page:=public.get_task_item_snapshot_page(v_task);
  begin
    perform public.create_task_item(v_task,'Must roll back');
    raise exception 'Rollback the item and its revision' using errcode='P0002';
  exception when sqlstate 'P0002' then null; end;
  v_current:=public.get_task_item_snapshot_page(v_task,p_revision=>(v_page->>'revision')::bigint);
  if (v_current->>'total')::int<>1 then raise exception 'Rolled-back snapshot was published'; end if;
end $$;

do $$
declare v_first jsonb; v_replay jsonb;
begin
  v_first:=public.execute_client_mutation('a22f0000-0000-4000-8000-000000000010','create_project','{"p_name":"SQL receipt"}');
  v_replay:=public.execute_client_mutation('a22f0000-0000-4000-8000-000000000010','create_project','{"p_name":"SQL receipt"}');
  if v_first is distinct from v_replay then raise exception 'Replay result changed'; end if;
end $$;

reset role;
do $$
declare v_budget private.client_operation_budgets%rowtype;
begin
  select * into strict v_budget from private.client_operation_budgets where user_id='a22f0000-0000-4000-8000-000000000001';
  if v_budget.receipt_count<>1 or v_budget.logical_bytes<>(select sum(accounted_bytes) from private.client_operation_receipts where user_id=v_budget.user_id)
    or exists(select 1 from private.client_operation_receipts where user_id=v_budget.user_id and (request_payload is not null or octet_length(request_fingerprint)<>32)) then
    raise exception 'Receipt accounting or compaction is inconsistent';
  end if;
  begin
    delete from private.client_operation_receipts where user_id=v_budget.user_id;
    raise exception 'Completed receipt was removed';
  exception when sqlstate '22023' then null; end;
  update private.client_operation_policy set max_logical_bytes=v_budget.logical_bytes;
end $$;
set local role authenticated;
do $$
begin
  perform public.execute_client_mutation('a22f0000-0000-4000-8000-000000000010','create_project','{"p_name":"SQL receipt"}');
  begin
    perform public.execute_client_mutation('a22f0000-0000-4000-8000-000000000011','create_project','{"p_name":"Must not execute"}');
    raise exception 'Byte budget admitted a new write';
  exception when sqlstate 'PT507' then null; end;
  if exists(select 1 from public.projects where name='Must not execute') then raise exception 'Budget rejection committed business effects'; end if;
end $$;
rollback;
