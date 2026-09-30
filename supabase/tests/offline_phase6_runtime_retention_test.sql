\set ON_ERROR_STOP on
begin;

do $$
begin
  if has_table_privilege('authenticated','private.offline_runtime_config','SELECT')
     or has_table_privilege('anon','private.offline_runtime_config','SELECT')
     or has_table_privilege('authenticated','private.task_item_sync_retention','SELECT')
     or has_function_privilege('anon','public.get_offline_runtime_config()','EXECUTE')
     or has_function_privilege('anon','public.pull_task_item_changes_v2(bigint,integer)','EXECUTE')
     or has_function_privilege('authenticated','private.cleanup_task_item_sync_changes()','EXECUTE')
     or not has_function_privilege('authenticated','public.get_offline_runtime_config()','EXECUTE')
     or not has_function_privilege('authenticated','public.pull_task_item_changes_v2(bigint,integer)','EXECUTE') then
    raise exception 'Phase 6 ACL failed';
  end if;
  if (select write_enabled or sync_enabled from private.offline_runtime_config where singleton) then
    raise exception 'Phase 6 remote flags must default off';
  end if;
end $$;

insert into private.client_operation_receipts
  (user_id,operation_id,operation_type,task_item_id,request_payload,result_payload,completed_at)
values ('93000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000002',
  'set_task_item_percentage_v2','93000000-0000-4000-8000-000000000003','{}','{}',now());
insert into private.task_item_sync_changes(project_id,task_id,task_item_id,change_type,item,created_at)
values
  ('93000000-0000-4000-8000-000000000010','93000000-0000-4000-8000-000000000011',
   '93000000-0000-4000-8000-000000000012','delete',null,now()-interval '91 days'),
  ('93000000-0000-4000-8000-000000000010','93000000-0000-4000-8000-000000000011',
   '93000000-0000-4000-8000-000000000013','delete',null,now());

do $$
declare v_old bigint; v_new bigint; v_floor bigint;
begin
  select min(cursor), max(cursor) into v_old, v_new from private.task_item_sync_changes
    where task_id='93000000-0000-4000-8000-000000000011';
  v_floor := private.cleanup_task_item_sync_changes();
  if v_floor <> v_old or exists(select 1 from private.task_item_sync_changes where cursor=v_old)
     or not exists(select 1 from private.task_item_sync_changes where cursor=v_new) then
    raise exception 'feed retention or floor incorrect';
  end if;
  if not exists(select 1 from private.client_operation_receipts
    where operation_id='93000000-0000-4000-8000-000000000002') then
    raise exception 'Phase 4 receipt was removed';
  end if;
end $$;

set local role authenticated;
select pg_catalog.set_config('request.jwt.claim.sub','93000000-0000-4000-8000-000000000001',true);
do $$
declare v_config jsonb; v_page jsonb; v_floor bigint; v_old_failed boolean := false;
begin
  v_config := public.get_offline_runtime_config();
  if v_config->>'write_enabled' <> 'false' or v_config->>'sync_enabled' <> 'false'
     or v_config->>'protocol_version' <> '2' then
    raise exception 'runtime config response incorrect';
  end if;
  v_page := public.pull_task_item_changes_v2(0,100);
  if v_page->>'reset_required' <> 'true' then raise exception 'stale cursor did not request reset'; end if;
  v_floor := (v_page->>'retained_after_cursor')::bigint;
  begin
    perform public.pull_task_item_changes(0,100);
  exception when sqlstate 'P0001' then v_old_failed := true;
  end;
  if not v_old_failed then raise exception 'old Phase 5 RPC silently skipped stale cursor'; end if;
  v_page := public.pull_task_item_changes_v2(v_floor,100);
  if v_page ? 'reset_required' or (v_page->>'next_cursor')::bigint < v_floor then
    raise exception 'current cursor cannot continue';
  end if;
end $$;
rollback;
