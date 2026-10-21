\set ON_ERROR_STOP on
begin;
select set_config('tasktrace.legacy_item',(select item_id::text from public.followup_upgrade_ids),true);
select set_config('tasktrace.legacy_project',(select project_id::text from public.followup_upgrade_ids),true);
set local role authenticated;
select set_config('request.jwt.claim.sub','74000000-0000-4000-8000-000000000002',true);
do $$
begin
  if not exists(select 1 from public.audit_log where entity_id=current_setting('tasktrace.legacy_item')::uuid and new_data->>'comment'='Legacy immutable comment' and not new_data?'task_id') then
    raise exception 'legacy immutable history not restored through parent mapping'; end if;
  if not exists(select 1 from public.audit_log where entity_id=current_setting('tasktrace.legacy_item')::uuid and new_data->>'percentage'='65') then raise exception 'legacy progress hidden'; end if;
end $$;
reset role;
delete from public.project_members where project_id=current_setting('tasktrace.legacy_project')::uuid and user_id='74000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub','74000000-0000-4000-8000-000000000002',true);
do $$begin if exists(select 1 from public.audit_log where project_id=current_setting('tasktrace.legacy_project')::uuid) then raise exception 'legacy history remains after revoke'; end if; end $$;
reset role;
rollback;
