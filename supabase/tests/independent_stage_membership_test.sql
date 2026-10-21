\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email,aud,role,raw_app_meta_data,raw_user_meta_data,email_confirmed_at,created_at,updated_at,is_anonymous,is_sso_user)
select ('71000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'stage-user-'||n||'@test.local',
  'authenticated','authenticated','{}',jsonb_build_object('display_name','Stage User '||n),now(),now(),now(),false,false
from generate_series(1,6) n;
create temp table stage_state(key text primary key,id uuid);
grant all on stage_state to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000001',true);
insert into stage_state values('project',public.create_project('Independent membership','Private project details'));
insert into stage_state values('stage',public.create_task((select id from stage_state where key='project'),'Shared stage'));
insert into stage_state values('sibling',public.create_task((select id from stage_state where key='project'),'Private sibling'));
insert into stage_state values('item',public.create_task_item((select id from stage_state where key='stage'),'Shared item'));
insert into stage_state values('sibling_item',public.create_task_item((select id from stage_state where key='sibling'),'Private item'));
select public.add_project_member((select id from stage_state where key='project'),'71000000-0000-4000-8000-000000000002','admin');
select public.add_project_member((select id from stage_state where key='project'),'71000000-0000-4000-8000-000000000003','member');
do $$declare result jsonb; begin
 result:=public.add_task_member_by_identifier((select id from stage_state where key='stage'),'stage-user-4@test.local','member');
 if result->>'success'<>'true' then raise exception 'stage invite failed: %',result; end if;
end $$;
select public.add_task_assignee((select id from stage_state where key='stage'),'71000000-0000-4000-8000-000000000004');
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000004',true);
do $$declare v_stage uuid := (select id from stage_state where key='stage'); v_context jsonb; v_rows jsonb; begin
 if exists(select 1 from public.project_members where user_id=auth.uid()) then raise exception 'invite changed project membership'; end if;
 if exists(select 1 from public.projects) then raise exception 'stage user can read project data'; end if;
 if (select count(*) from public.tasks)<>1 then raise exception 'sibling stage leaked'; end if;
 if (select count(*) from public.task_items)<>1 then raise exception 'sibling checklist leaked'; end if;
 if public.get_my_task_role(v_stage)<>'member' then raise exception 'direct role not effective'; end if;
 v_context:=public.get_task_project_context(v_stage);
 if v_context->>'role' is not null or v_context ? 'description' or v_context->>'name'<>'Independent membership' then raise exception 'bad minimal context'; end if;
 if not exists(select 1 from public.list_task_participants(v_stage) where user_id=auth.uid() and is_direct) then raise exception 'direct participant missing'; end if;
 perform public.set_task_item_percentage((select id from stage_state where key='item'),42,(select sync_version from public.task_items where id=(select id from stage_state where key='item')));
 if exists(select 1 from public.audit_log where entity_id=(select id from stage_state where key='sibling')) then raise exception 'sibling audit leaked'; end if;
 if not private.can_receive_realtime_topic('task:'||v_stage) then raise exception 'direct task broadcast denied'; end if;
 if private.can_receive_realtime_topic('project:'||(select id from stage_state where key='project'))
   or private.can_receive_realtime_topic('task:'||(select id from stage_state where key='sibling')) then raise exception 'unrelated broadcast allowed'; end if;
 select jsonb_agg(row_data) into v_rows from private.offline_account_rows('tasks');
 if jsonb_array_length(v_rows)<>1 then raise exception 'offline sibling tasks leaked'; end if;
 if exists(select 1 from private.offline_account_rows('projects')) then raise exception 'offline project leaked'; end if;
 select row_data into v_rows from private.offline_account_rows('roles');
 if v_rows->'project_context'->>'role' is not null or v_rows->'participants' is null then raise exception 'offline context missing'; end if;
 begin perform public.create_task_item(v_stage,'Denied'); raise exception 'member created item'; exception when insufficient_privilege then null; end;
 begin perform public.set_task_member_override(v_stage,auth.uid(),'admin'); raise exception 'self promotion succeeded'; exception when insufficient_privilege then null; end;
 begin perform public.add_task_member_by_identifier(v_stage,'stage-user-5@test.local','admin'); raise exception 'member invited user'; exception when insufficient_privilege then null; end;
 begin perform public.update_task(v_stage,'Denied','',(select title from public.tasks where id=v_stage),(select description from public.tasks where id=v_stage)); raise exception 'member edited stage'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000001',true);
select public.set_task_member_override((select id from stage_state where key='stage'),'71000000-0000-4000-8000-000000000004','admin');
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000004',true);
select public.create_task_item((select id from stage_state where key='stage'),'Local admin item');
do $$begin
 begin perform public.add_task_assignee((select id from stage_state where key='stage'),auth.uid()); raise exception 'checklist admin assigned'; exception when insufficient_privilege then null; end;
 begin perform public.add_project_member((select id from stage_state where key='project'),'71000000-0000-4000-8000-000000000005','member'); raise exception 'local admin changed project'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000001',true);
select public.set_task_member_override((select id from stage_state where key='stage'),'71000000-0000-4000-8000-000000000004','viewer');
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000004',true);
do $$begin
 begin perform public.set_task_item_percentage((select id from stage_state where key='item'),60,(select sync_version from public.task_items where id=(select id from stage_state where key='item'))); raise exception 'viewer edited item'; exception when insufficient_privilege then null; end;
 if not exists(select 1 from public.notifications where type='task_member_added') then raise exception 'invite notification absent'; end if;
end $$;
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000001',true);
-- Direct add/remove of an existing project member never touches project role.
select public.add_task_member_by_identifier((select id from stage_state where key='stage'),'stage-user-3@test.local','viewer');
select public.clear_task_member_override((select id from stage_state where key='stage'),'71000000-0000-4000-8000-000000000003');
do $$begin
 if not exists(select 1 from public.task_members where task_id=(select id from stage_state where key='stage')
   and user_id='71000000-0000-4000-8000-000000000003' and is_direct and role_override is null) then
   raise exception 'clearing override also removed direct membership';
 end if;
end $$;
select public.remove_task_member((select id from stage_state where key='stage'),'71000000-0000-4000-8000-000000000003');
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000003',true);
do $$begin
 if public.get_my_task_role((select id from stage_state where key='stage'))<>'member' then raise exception 'inherited access lost'; end if;
 if (select role from public.project_members where user_id=auth.uid())<>'member' then raise exception 'project role changed'; end if;
 if (select count(*) from public.tasks)<>2 then raise exception 'project access changed'; end if;
end $$;
-- Project administrators cannot change a project owner's/admin's stage role.
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000002',true);
do $$begin
 begin perform public.set_task_member_override((select id from stage_state where key='stage'),'71000000-0000-4000-8000-000000000001','viewer'); raise exception 'admin demoted owner'; exception when insufficient_privilege then null; end;
 begin perform public.remove_task_member((select id from stage_state where key='stage'),auth.uid()); raise exception 'self role change'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000001',true);
select public.remove_task_member((select id from stage_state where key='stage'),'71000000-0000-4000-8000-000000000004');
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000004',true);
do $$begin
 if exists(select 1 from public.tasks) or exists(select 1 from public.task_items) or exists(select 1 from public.task_assignees) then raise exception 'revoked stage data visible'; end if;
 if exists(select 1 from private.offline_account_rows('tasks')) or exists(select 1 from private.offline_account_rows('items')) then raise exception 'revoked bootstrap data visible'; end if;
 if not exists(select 1 from public.notifications where type='task_member_removed') then raise exception 'removal notification absent'; end if;
 begin perform public.get_my_task_role((select id from stage_state where key='stage')); raise exception 'revoked effective role'; exception when insufficient_privilege then null; end;
end $$;
-- A historical orphan row without is_direct never grants access.
reset role;
insert into public.task_members(task_id,user_id,set_by,role_override) values((select id from stage_state where key='stage'),'71000000-0000-4000-8000-000000000006','71000000-0000-4000-8000-000000000001','admin');
set local role authenticated;
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000006',true);
do $$begin if exists(select 1 from public.tasks) then raise exception 'legacy orphan promoted'; end if; end $$;
rollback;
