\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('73000000-0000-4000-8000-000000000001','followup-owner@test.local','{"display_name":"Followup owner"}'),
 ('73000000-0000-4000-8000-000000000002','followup-member@test.local','{"display_name":"Followup member"}'),
 ('73000000-0000-4000-8000-000000000003','followup-outsider@test.local','{"display_name":"Followup outsider"}');
set local role authenticated;
select set_config('request.jwt.claim.sub','73000000-0000-4000-8000-000000000001',true);
select public.create_project('Followup project') p \gset
select set_config('tasktrace.followup_project',:'p',true);
select public.add_project_member(:'p','73000000-0000-4000-8000-000000000002','member');
select public.create_task(:'p','Followup task') t \gset
select set_config('tasktrace.followup_task',:'t',true);
select public.create_task_item(:'t','Followup item') i \gset
select set_config('tasktrace.followup_item',:'i',true);
do $$
declare v_item uuid:=current_setting('tasktrace.followup_item')::uuid; v_version bigint; v_result jsonb; v_page jsonb;
begin
  select sync_version into v_version from public.task_items where id=v_item;
  perform public.set_task_item_comment(v_item,'Remote comment',v_version);
  begin perform public.set_task_item_comment(v_item,'Stale comment',v_version); raise exception 'stale comment accepted'; exception when sqlstate 'PT409' then null; end;
  begin perform public.set_task_item_percentage(v_item,80,v_version); raise exception 'stale percentage accepted'; exception when sqlstate 'PT409' then null; end;
  select sync_version into v_version from public.task_items where id=v_item;
  perform public.update_task_item(v_item,'Remote title',v_version);
  begin perform public.update_task_item(v_item,'Stale title',v_version); raise exception 'stale title accepted'; exception when sqlstate 'PT409' then null; end;
  if (select comment from public.task_items where id=v_item)<>'Remote comment' then raise exception 'comment lost'; end if;
  v_page:=public.get_task_item_snapshot_page(current_setting('tasktrace.followup_task')::uuid,'active',0,500);
  perform public.create_task_item(current_setting('tasktrace.followup_task')::uuid,'Changed snapshot');
  begin perform public.get_task_item_snapshot_page(current_setting('tasktrace.followup_task')::uuid,'active',0,500,(v_page->>'revision')::bigint);
    raise exception 'changed snapshot accepted'; exception when sqlstate 'PT409' then null; end;
  v_result:=public.execute_client_mutation('73000000-0000-4000-8000-000000000011','create_task',jsonb_build_object('p_project_id',current_setting('tasktrace.followup_project'),'p_title','Exactly once'));
  if public.execute_client_mutation('73000000-0000-4000-8000-000000000011','create_task',jsonb_build_object('p_project_id',current_setting('tasktrace.followup_project'),'p_title','Exactly once')) is distinct from v_result then raise exception 'receipt replay changed result'; end if;
  if (select count(*) from public.tasks where project_id=current_setting('tasktrace.followup_project')::uuid and title='Exactly once')<>1 then raise exception 'duplicate online mutation'; end if;
  begin perform public.execute_client_mutation('73000000-0000-4000-8000-000000000011','create_task',jsonb_build_object('p_project_id',current_setting('tasktrace.followup_project'),'p_title','Different'));
    raise exception 'receipt payload substitution accepted'; exception when sqlstate '22023' then null; end;
  begin perform public.execute_client_mutation('73000000-0000-4000-8000-000000000012','get_task_item_sync_cursor','{}');
    raise exception 'unlisted dispatch accepted'; exception when sqlstate '22023' then null; end;
end $$;
select public.archive_task_item(:'i');
select public.hard_delete_task_item(:'i');
select set_config('request.jwt.claim.sub','73000000-0000-4000-8000-000000000002',true);
do $$
begin
  if not exists(select 1 from public.audit_log where entity_id=current_setting('tasktrace.followup_item')::uuid and new_data->>'comment'='Remote comment') then raise exception 'deleted item history hidden'; end if;
end $$;
select set_config('request.jwt.claim.sub','73000000-0000-4000-8000-000000000003',true);
do $$
begin
  if exists(select 1 from public.audit_log where project_id=current_setting('tasktrace.followup_project')::uuid) then raise exception 'outsider history leak'; end if;
  begin perform public.get_task_item_snapshot_page(current_setting('tasktrace.followup_task')::uuid); raise exception 'outsider snapshot leak'; exception when sqlstate '42501' then null; end;
  begin perform public.execute_client_mutation('73000000-0000-4000-8000-000000000013','create_task',jsonb_build_object('p_project_id',current_setting('tasktrace.followup_project'),'p_title','Forbidden'));
    raise exception 'dispatch bypassed authorization'; exception when sqlstate '42501' then null; end;
end $$;
select set_config('request.jwt.claim.sub','73000000-0000-4000-8000-000000000001',true);
select public.set_task_member_override(:'t','73000000-0000-4000-8000-000000000002','viewer');
select public.transfer_project_ownership(:'p','73000000-0000-4000-8000-000000000002');
select set_config('request.jwt.claim.sub','73000000-0000-4000-8000-000000000002',true);
do $$
begin
  if public.get_my_task_role(current_setting('tasktrace.followup_task')::uuid)<>'owner' then raise exception 'new owner retains override'; end if;
  if not exists(select 1 from public.audit_log where entity_type='task_member' and entity_id=auth.uid() and old_data->>'role_override'='viewer' and new_data->>'inherited_role'='owner') then raise exception 'override clearing unaudited'; end if;
end $$;
select public.create_task_template('Followup template') template \gset
select set_config('tasktrace.followup_template',:'template',true);
select public.create_task_template_item(:'template','First','Instructions') template_item \gset
do $$
declare v_page jsonb; v_next jsonb; v_id uuid;
begin
  v_page:=public.get_task_template_page_v2(current_setting('tasktrace.followup_template')::uuid,0,1);
  if v_page->>'total'<>'1' or v_page->'rows'->0->>'description'<>'Instructions' then raise exception 'template page/count invalid'; end if;
  perform public.create_task_template_item(current_setting('tasktrace.followup_template')::uuid,'Second');
  begin perform public.get_task_template_page_v2(current_setting('tasktrace.followup_template')::uuid,1,1,v_page->>'revision',v_page->'next');
    raise exception 'stale template revision accepted'; exception when sqlstate 'PT409' then null; end;
  v_page:=public.get_task_template_page_v2(current_setting('tasktrace.followup_template')::uuid,0,1);
  v_next:=public.get_task_template_page_v2(current_setting('tasktrace.followup_template')::uuid,1,1,v_page->>'revision',v_page->'next');
  if v_next->'rows'->0->>'title'<>'Second' then raise exception 'keyset skipped/repeated item'; end if;
  v_id:=public.create_task_from_template(current_setting('tasktrace.followup_project')::uuid,current_setting('tasktrace.followup_template')::uuid);
  if (select count(*) from public.task_items where task_id=v_id)<>2 or (select status from public.tasks where id=v_id)<>'not_started' then raise exception 'bulk copy integrity/status'; end if;
  if not exists(select 1 from public.task_items where task_id=v_id and description='Instructions') then raise exception 'copy lost instructions'; end if;
end $$;
reset role;
do $$
begin
  if has_function_privilege('anon','public.execute_client_mutation(uuid,text,jsonb)','execute')
    or has_function_privilege('service_role','public.execute_client_mutation(uuid,text,jsonb)','execute')
    or has_table_privilege('authenticated','private.audit_item_parents','select')
    or has_table_privilege('authenticated','private.template_read_state','select') then raise exception 'followup ACL regression'; end if;
end $$;
rollback;
