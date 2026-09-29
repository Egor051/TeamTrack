\set ON_ERROR_STOP on
begin;

insert into auth.users (id,email,aud,role,raw_app_meta_data,raw_user_meta_data,
  email_confirmed_at,created_at,updated_at,is_anonymous,is_sso_user)
values
 ('91000000-0000-4000-8000-000000000001','offline-owner@test.local','authenticated','authenticated','{}','{"display_name":"Offline Owner"}',now(),now(),now(),false,false),
 ('91000000-0000-4000-8000-000000000002','offline-member@test.local','authenticated','authenticated','{}','{"display_name":"Offline Member"}',now(),now(),now(),false,false);

do $$
begin
  if has_table_privilege('anon','private.client_operation_receipts','SELECT')
    or has_table_privilege('authenticated','private.client_operation_receipts','SELECT')
    or has_table_privilege('authenticated','private.client_operation_receipts','INSERT') then
    raise exception 'receipt table is directly accessible';
  end if;
  if has_function_privilege('anon','public.apply_task_item_state_operation(uuid,uuid,boolean)','EXECUTE')
    or not has_function_privilege('authenticated','public.apply_task_item_state_operation(uuid,uuid,boolean)','EXECUTE') then
    raise exception 'RPC grants are incorrect';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000001',true);
select public.create_project('Offline receipts','test') \gset
\set project :create_project
select public.create_task(:'project','Offline task','active') \gset
\set task :create_task
select public.create_task_item(:'task','Offline item') \gset
\set item :create_task_item
select set_config('tasktrace.test_item', :'item', true);
select public.add_project_member(:'project','91000000-0000-4000-8000-000000000002','member');

do $$
declare
  v_item uuid := current_setting('tasktrace.test_item')::uuid;
  v_audit integer;
  v_actions integer;
  v_notifications integer;
begin
  perform public.apply_task_item_state_operation('91000000-0000-4000-8000-000000000011',v_item,true);
  select count(*) into v_audit from public.audit_log where entity_id=v_item;
  select count(*) into v_actions from public.item_actions where task_item_id=v_item;
  select count(*) into v_notifications from public.notifications where data->>'entity_id'=v_item::text;
  if not public.apply_task_item_state_operation('91000000-0000-4000-8000-000000000011',v_item,true) then
    raise exception 'state retry result differs';
  end if;
  if (select count(*) from public.audit_log where entity_id=v_item) <> v_audit
     or (select count(*) from public.item_actions where task_item_id=v_item) <> v_actions
     or (select count(*) from public.notifications where data->>'entity_id'=v_item::text) <> v_notifications then
    raise exception 'state duplicate side effects';
  end if;

  if public.apply_task_item_percentage_operation('91000000-0000-4000-8000-000000000012',v_item,70) <> 70 then
    raise exception 'percentage result differs';
  end if;
  select count(*) into v_audit from public.audit_log where entity_id=v_item;
  select count(*) into v_notifications from public.notifications where data->>'entity_id'=v_item::text;
  perform public.apply_task_item_percentage_operation('91000000-0000-4000-8000-000000000012',v_item,70);
  if (select count(*) from public.audit_log where entity_id=v_item) <> v_audit
     or (select count(*) from public.notifications where data->>'entity_id'=v_item::text) <> v_notifications then
    raise exception 'percentage duplicate side effects';
  end if;
  begin
    perform public.apply_task_item_percentage_operation('91000000-0000-4000-8000-000000000012',v_item,20);
    raise exception 'mismatched duplicate accepted';
  exception when sqlstate '22023' then null;
  end;
  if (select percentage from public.task_items where id=v_item) <> 70 then
    raise exception 'mismatched duplicate changed state';
  end if;
  begin
    perform public.apply_task_item_percentage_operation('91000000-0000-4000-8000-000000000011',v_item,70);
    raise exception 'operation type reuse accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.apply_task_item_percentage_operation('91000000-0000-4000-8000-000000000012',
      '91000000-0000-4000-8000-000000000099',70);
    raise exception 'task item reuse accepted';
  exception when sqlstate '22023' then null;
  end;

  perform public.apply_task_item_comment_operation('91000000-0000-4000-8000-000000000013',v_item,' hello ');
  select count(*) into v_audit from public.audit_log where entity_id=v_item;
  select count(*) into v_notifications from public.notifications where data->>'entity_id'=v_item::text;
  if public.apply_task_item_comment_operation('91000000-0000-4000-8000-000000000013',v_item,'hello') <> 'hello' then
    raise exception 'canonical comment retry differs';
  end if;
  if (select count(*) from public.audit_log where entity_id=v_item) <> v_audit
     or (select count(*) from public.notifications where data->>'entity_id'=v_item::text) <> v_notifications then
    raise exception 'comment duplicate side effects';
  end if;

  begin
    perform public.apply_task_item_percentage_operation('91000000-0000-4000-8000-000000000014',
      '91000000-0000-4000-8000-000000000099',10);
    raise exception 'missing item mutation accepted';
  exception when raise_exception then null;
  end;
end $$;

select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000002',true);
do $$
begin
  if public.apply_task_item_state_operation('91000000-0000-4000-8000-000000000011',
      current_setting('tasktrace.test_item')::uuid,false) then
    raise exception 'cross-user receipt leaked first user result';
  end if;
end $$;

reset role;
delete from public.project_members where project_id=:'project' and user_id='91000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub','91000000-0000-4000-8000-000000000002',true);
do $$
declare
  v_denied boolean := false;
begin
  begin
    perform public.apply_task_item_percentage_operation('91000000-0000-4000-8000-000000000015',
      current_setting('tasktrace.test_item')::uuid,25);
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then raise exception 'revoked member replay was accepted'; end if;
end $$;
reset role;
do $$
begin
  if (select count(*) from private.client_operation_receipts
      where user_id='91000000-0000-4000-8000-000000000001') <> 3 then
    raise exception 'failed mutation left receipt or successes missing';
  end if;
  if (select count(*) from private.client_operation_receipts
      where user_id='91000000-0000-4000-8000-000000000002') <> 1 then
    raise exception 'cross-user receipt scope failed';
  end if;
end $$;
rollback;
