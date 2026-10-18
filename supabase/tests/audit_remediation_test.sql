\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email,aud,role,raw_app_meta_data,raw_user_meta_data,email_confirmed_at,created_at,updated_at,is_anonymous,is_sso_user)
select ('72000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'audit-remediation-'||n||'@test.local',
  'authenticated','authenticated','{}',jsonb_build_object('display_name','Audit User '||n),now(),now(),now(),false,false
from generate_series(1,9) n;
create temp table remediation_state(key text primary key,id uuid);
grant all on remediation_state to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','72000000-0000-4000-8000-000000000001',true);
insert into remediation_state values('project',public.create_project('Audit remediation','Original'));
insert into remediation_state values('task',public.create_task((select id from remediation_state where key='project'),'Visible'));
insert into remediation_state values('sibling',public.create_task((select id from remediation_state where key='project'),'Sibling'));
insert into remediation_state values('item',public.create_task_item((select id from remediation_state where key='task'),'Deadline item'));
insert into remediation_state values('template',public.create_task_template('Original template','Original'));
insert into remediation_state values('template_item',public.create_task_template_item((select id from remediation_state where key='template'),'Original item','Original'));
select public.add_project_member((select id from remediation_state where key='project'),'72000000-0000-4000-8000-000000000002','admin');
select public.add_project_member((select id from remediation_state where key='project'),'72000000-0000-4000-8000-000000000003','member');
select public.add_project_member((select id from remediation_state where key='project'),'72000000-0000-4000-8000-000000000004','viewer');
select public.add_task_member_by_identifier((select id from remediation_state where key='task'),'audit-remediation-5@test.local','admin');
select public.add_task_member_by_identifier((select id from remediation_state where key='task'),'audit-remediation-6@test.local','member');
select public.add_task_member_by_identifier((select id from remediation_state where key='task'),'audit-remediation-7@test.local','viewer');
select public.add_task_member_by_identifier((select id from remediation_state where key='task'),'audit-remediation-8@test.local','member');

do $$declare v_item uuid := (select id from remediation_state where key='item'); v_version bigint; begin
  select sync_version into v_version from public.task_items where id=v_item;
  perform public.set_task_item_deadline(v_item,now()+interval '2 days',v_version);
  select sync_version into v_version from public.task_items where id=v_item;
  perform public.set_task_item_deadline(v_item,now()+interval '3 days',v_version);
  select sync_version into v_version from public.task_items where id=v_item;
  perform public.set_task_item_deadline(v_item,null,v_version);
end $$;
select public.remove_task_member((select id from remediation_state where key='task'),'72000000-0000-4000-8000-000000000008');

-- B04 exercises RLS itself, not just an owner/SECURITY DEFINER query.
do $$declare n integer; v_count integer; begin
  for n in 1..9 loop
    perform set_config('request.jwt.claim.sub','72000000-0000-4000-8000-'||lpad(n::text,12,'0'),true);
    select count(*) into v_count from public.audit_log where entity_type='task_item_deadline'
      and entity_id=(select id from remediation_state where key='item');
    if v_count <> (case when n<=7 then 3 else 0 end) then raise exception 'B04 role % sees % events',n,v_count; end if;
    if n between 5 and 7 and exists(select 1 from public.audit_log where entity_id=(select id from remediation_state where key='sibling')) then
      raise exception 'B04 sibling history leaked';
    end if;
  end loop;
end $$;
select set_config('request.jwt.claim.sub','72000000-0000-4000-8000-000000000009',true);
insert into remediation_state values('foreign_project',public.create_project('Foreign project',''));
insert into remediation_state values('foreign_task',public.create_task((select id from remediation_state where key='foreign_project'),'Foreign'));
insert into remediation_state values('foreign_item',public.create_task_item((select id from remediation_state where key='foreign_task'),'Foreign item'));
select public.set_task_item_deadline((select id from remediation_state where key='foreign_item'),now()+interval '1 day',1);
select set_config('request.jwt.claim.sub','72000000-0000-4000-8000-000000000006',true);
do $$begin
  if exists(select 1 from public.audit_log where project_id=(select id from remediation_state where key='foreign_project')) then raise exception 'B04 cross-project history leaked'; end if;
  begin update public.audit_log set new_data='{}' where entity_id=(select id from remediation_state where key='item');
    exception when insufficient_privilege then null; end;
  if (select count(*) from public.audit_log where entity_type='task_item_deadline' and new_data ? 'task_id' and entity_id=(select id from remediation_state where key='item'))<>3 then
    raise exception 'audit modified or incomplete'; end if;
end $$;

-- B01: stale writes cannot silently overwrite saved fields; legacy calls remain usable.
select set_config('request.jwt.claim.sub','72000000-0000-4000-8000-000000000001',true);
do $$declare v_project uuid := (select id from remediation_state where key='project');
  v_template uuid := (select id from remediation_state where key='template'); begin
  perform public.update_project(v_project,'External','Saved','Audit remediation','Original');
  begin perform public.update_project(v_project,'Lost update','Lost','Audit remediation','Original');
    raise exception 'B01 stale project write accepted'; exception when sqlstate 'PT409' then null; end;
  perform public.update_project(v_project,'Resolved','Saved','External','Saved');
  perform public.update_task_template(v_template,'External','Saved','Original template','Original');
  begin perform public.update_task_template(v_template,'Lost update','Lost','Original template','Original');
    raise exception 'B01 stale template write accepted'; exception when sqlstate 'PT409' then null; end;
  perform public.update_task_template(v_template,'Resolved','Saved','External','Saved');
  perform public.update_task_template_item((select id from remediation_state where key='template_item'),'External item','Saved','Original item','Original');
  begin perform public.update_task_template_item((select id from remediation_state where key='template_item'),'Lost item','Lost','Original item','Original');
    raise exception 'B01 stale template item accepted'; exception when sqlstate 'PT409' then null; end;
  if (select name from public.projects where id=v_project)<>'Resolved' then raise exception 'project CAS failed'; end if;
  if public.get_task_template(v_template)->>'name'<>'Resolved' then raise exception 'template CAS failed'; end if;
end $$;
select set_config('request.jwt.claim.sub','72000000-0000-4000-8000-000000000009',true);
do $$begin
  begin perform public.update_project((select id from remediation_state where key='project'),'Denied','','Resolved','Saved');
    raise exception 'outsider project CAS accepted'; exception when insufficient_privilege then null; end;
  begin perform public.update_task_template((select id from remediation_state where key='template'),'Denied','','Resolved','Saved');
    raise exception 'outsider template CAS accepted'; exception when insufficient_privilege then null; end;
end $$;

-- Historical payload link survives item deletion, without granting revoked users access.
reset role;
delete from public.task_items where id=(select id from remediation_state where key='item');
set local role authenticated;
do $$declare n integer; v_count integer; begin
  for n in 1..9 loop
    perform set_config('request.jwt.claim.sub','72000000-0000-4000-8000-'||lpad(n::text,12,'0'),true);
    select count(*) into v_count from public.audit_log where entity_type='task_item_deadline' and entity_id=(select id from remediation_state where key='item');
    if v_count <> (case when n<=7 then 3 else 0 end) then raise exception 'B04 deleted history role % sees %',n,v_count; end if;
  end loop;
end $$;
rollback;
