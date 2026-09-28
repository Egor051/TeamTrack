-- Canonical authorization, RLS, RPC, audit, profile, grant and limit regressions.
\set ON_ERROR_STOP on
begin;

create temp table sec_state (key text primary key, id uuid not null);
grant select, insert, update on sec_state to authenticated;

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data,
                        email_confirmed_at, created_at, updated_at, is_anonymous, is_sso_user)
values
 ('40000000-0000-4000-8000-000000000001','sec-owner@test.local','authenticated','authenticated','{}','{"display_name":"Security Owner"}',now(),now(),now(),false,false),
 ('40000000-0000-4000-8000-000000000002','sec-admin-a@test.local','authenticated','authenticated','{}','{"display_name":"Security Admin A"}',now(),now(),now(),false,false),
 ('40000000-0000-4000-8000-000000000003','sec-admin-b@test.local','authenticated','authenticated','{}','{"display_name":"Security Admin B"}',now(),now(),now(),false,false),
 ('40000000-0000-4000-8000-000000000004','sec-member@test.local','authenticated','authenticated','{}','{"display_name":"Security Member"}',now(),now(),now(),false,false),
 ('40000000-0000-4000-8000-000000000005','sec-viewer@test.local','authenticated','authenticated','{}','{"display_name":"Security Viewer"}',now(),now(),now(),false,false),
 ('40000000-0000-4000-8000-000000000006','sec-outsider@test.local','authenticated','authenticated','{}','{"display_name":"Security Outsider"}',now(),now(),now(),false,false),
 ('40000000-0000-4000-8000-000000000007','sec-case-user@test.local','authenticated','authenticated','{}','{"display_name":"Case User"}',now(),now(),now(),false,false),
 ('40000000-0000-4000-8000-000000000008','sec-self-heal@test.local','authenticated','authenticated','{}','{"display_name":"Self Heal"}',now(),now(),now(),false,false);
insert into sec_state values
 ('owner','40000000-0000-4000-8000-000000000001'),
 ('admin_a','40000000-0000-4000-8000-000000000002'),
 ('admin_b','40000000-0000-4000-8000-000000000003'),
 ('member','40000000-0000-4000-8000-000000000004'),
 ('viewer','40000000-0000-4000-8000-000000000005'),
 ('outsider','40000000-0000-4000-8000-000000000006'),
 ('case_user','40000000-0000-4000-8000-000000000007'),
 ('self_heal','40000000-0000-4000-8000-000000000008');

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from sec_state where key='owner'),true);
insert into sec_state select 'project', public.create_project('Security project','authorization matrix');
select public.add_project_member((select id from sec_state where key='project'),(select id from sec_state where key='admin_a'),'admin');
select public.add_project_member((select id from sec_state where key='project'),(select id from sec_state where key='admin_b'),'admin');
select public.add_project_member((select id from sec_state where key='project'),(select id from sec_state where key='member'),'member');
select public.add_project_member((select id from sec_state where key='project'),(select id from sec_state where key='viewer'),'viewer');
select public.add_project_member_by_identifier((select id from sec_state where key='project'),'SEC-CASE-USER@TEST.LOCAL','member');
insert into sec_state select 'task', public.create_task((select id from sec_state where key='project'),'Security stage','stage description');
insert into sec_state select 'item', public.create_task_item((select id from sec_state where key='task'),'Security item');
insert into sec_state select 'task_two', public.create_task((select id from sec_state where key='project'),'Second stage','for reorder');
reset role;

do $$ begin
  if (select count(*) from public.task_members where task_id=(select id from sec_state where key='task')) <>
     (select count(*) from public.project_members where project_id=(select id from sec_state where key='project')) then
    raise exception 'FAIL SEC01: inherited task role rows are incomplete';
  end if;
  if exists (select 1 from public.task_members where task_id=(select id from sec_state where key='task') and role_override is not null) then
    raise exception 'FAIL SEC01: inheritance created an explicit override';
  end if;
  if not exists (select 1 from public.project_members where project_id=(select id from sec_state where key='project') and user_id=(select id from sec_state where key='case_user')) then
    raise exception 'FAIL SEC02: case-insensitive email lookup';
  end if;
end $$;

-- Inherited roles and explicit checklist-only raise/lower behavior.
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from sec_state where key='member'),true);
do $$ begin
  if public.get_my_task_role((select id from sec_state where key='task')) <> 'member' then raise exception 'FAIL SEC03'; end if;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from sec_state where key='owner'),true);
select public.set_task_member_override((select id from sec_state where key='task'),(select id from sec_state where key='member'),'admin');
select public.set_task_member_override((select id from sec_state where key='task'),(select id from sec_state where key='admin_a'),'viewer');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from sec_state where key='member'),true);
select public.update_task_item((select id from sec_state where key='item'),'Raised checklist admin');
do $$ declare denied boolean:=false; begin
  if public.get_my_task_role((select id from sec_state where key='task')) <> 'admin' then raise exception 'FAIL SEC04'; end if;
  begin perform public.update_task((select id from sec_state where key='task'),'Project-level escalation',null); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL SEC04: checklist override escalated stage authority'; end if;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from sec_state where key='admin_a'),true);
select public.update_task((select id from sec_state where key='task'),'Admin still controls stage','project authority retained');
do $$ declare denied boolean:=false; begin
  if public.get_my_task_role((select id from sec_state where key='task')) <> 'viewer' then raise exception 'FAIL SEC05'; end if;
  begin perform public.set_task_item_percentage((select id from sec_state where key='item'),10); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL SEC05: lowered checklist viewer mutated progress'; end if;
end $$;
do $$ declare denied boolean:=false; begin
  begin perform public.remove_project_member((select id from sec_state where key='project'),(select id from sec_state where key='admin_b')); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL SEC06: admin removed peer admin'; end if;
  denied:=false;
  begin perform public.change_member_role((select id from sec_state where key='project'),(select id from sec_state where key='admin_b'),'member'); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL SEC06: admin demoted peer admin'; end if;
  denied:=false;
  begin perform public.add_project_member((select id from sec_state where key='project'),(select id from sec_state where key='outsider'),'admin'); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL SEC06: admin created peer admin'; end if;
  denied:=false;
  begin perform public.set_task_member_override((select id from sec_state where key='task'),(select id from sec_state where key='admin_b'),'viewer'); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL SEC06: admin changed peer admin checklist role'; end if;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from sec_state where key='owner'),true);
select public.clear_task_member_override((select id from sec_state where key='task'),(select id from sec_state where key='member'));
select public.clear_task_member_override((select id from sec_state where key='task'),(select id from sec_state where key='admin_a'));
select public.set_task_member_override((select id from sec_state where key='task'),(select id from sec_state where key='viewer'),'member');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from sec_state where key='viewer'),true);
select public.set_task_item_percentage((select id from sec_state where key='item'),25);
do $$ declare denied boolean:=false; begin
  begin perform public.update_task_item((select id from sec_state where key='item'),'Viewer structural edit'); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL SEC07: member override granted checklist-admin authority'; end if;
end $$;
reset role;

-- Cross-tenant RLS isolation.
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from sec_state where key='outsider'),true);
do $$ begin
  if exists (select 1 from public.projects where id=(select id from sec_state where key='project')) then raise exception 'FAIL SEC08 project IDOR'; end if;
  if exists (select 1 from public.tasks where id=(select id from sec_state where key='task')) then raise exception 'FAIL SEC08 task IDOR'; end if;
  if exists (select 1 from public.task_items where id=(select id from sec_state where key='item')) then raise exception 'FAIL SEC08 item IDOR'; end if;
  if exists (select 1 from public.audit_log where project_id=(select id from sec_state where key='project')) then raise exception 'FAIL SEC08 audit IDOR'; end if;
end $$;
do $$ declare denied boolean; begin
  denied:=false;
  begin perform public.update_project((select id from sec_state where key='project'),'Fail closed',null); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL SEC08: null project role bypassed project mutation'; end if;
  denied:=false;
  begin perform public.set_task_item_comment((select id from sec_state where key='item'),'Fail closed'); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL SEC08: null task role bypassed checklist mutation'; end if;
  denied:=false;
  begin perform * from public.list_task_member_overrides((select id from sec_state where key='task')); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL SEC08: null project role disclosed override metadata'; end if;
end $$;
reset role;

-- Canonical profile RPC: self-heal, exact old/new audit, no direct/metadata overwrite.
delete from public.profiles where id=(select id from sec_state where key='self_heal');
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from sec_state where key='self_heal'),true);
do $$ declare p public.profiles; begin
  p := public.get_my_profile();
  if p.id <> (select id from sec_state where key='self_heal') or p.display_name <> 'Self Heal' then raise exception 'FAIL SEC09 profile self-heal'; end if;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from sec_state where key='member'),true);
select public.update_my_profile('Canonical Member');
do $$ declare denied boolean:=false; n integer:=0; begin
  begin
    update public.profiles set display_name='Bypass' where id=(select id from sec_state where key='member');
    get diagnostics n = row_count;
  exception when insufficient_privilege then denied:=true; end;
  if not denied or n <> 0 then raise exception 'FAIL SEC10 direct profile update'; end if;
  if not exists (
    select 1 from public.audit_log
     where entity_type='profile' and entity_id=(select id from sec_state where key='member')
       and old_data @> '{"display_name":"Security Member"}'::jsonb
       and new_data @> '{"display_name":"Canonical Member"}'::jsonb
  ) then raise exception 'FAIL SEC10 profile audit'; end if;
end $$;
reset role;
update auth.users set raw_user_meta_data='{"display_name":"Metadata Overwrite"}' where id=(select id from sec_state where key='member');
do $$ begin
  if (select display_name from public.profiles where id=(select id from sec_state where key='member')) <> 'Canonical Member' then raise exception 'FAIL SEC11 metadata overwrote profile'; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from sec_state where key='admin_a'),true);
do $$ begin
  if exists (select 1 from public.audit_log where entity_type='profile' and entity_id=(select id from sec_state where key='member')) then raise exception 'FAIL SEC12 project admin saw member profile history'; end if;
  if not exists (select 1 from public.audit_log where project_id=(select id from sec_state where key='project')) then raise exception 'FAIL SEC12 project admin cannot see project audit'; end if;
end $$;
reset role;

-- Template provenance is creator-only; task_from_template is project-scoped.
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from sec_state where key='owner'),true);
insert into sec_state select 'template', public.create_task_template('Security template','template audit');
select public.create_task_template_item((select id from sec_state where key='template'),'Template item');
insert into sec_state select 'from_template', public.create_task_from_template((select id from sec_state where key='project'),(select id from sec_state where key='template'),'From template','copied');
do $$ begin
  if not exists (select 1 from public.audit_log where entity_type='task_template' and entity_id=(select id from sec_state where key='template')) then raise exception 'FAIL SEC13 creator template audit'; end if;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from sec_state where key='admin_a'),true);
do $$ begin
  if exists (select 1 from public.audit_log where entity_type in ('task_template','task_template_item')) then raise exception 'FAIL SEC13 foreign template audit visible'; end if;
  if not exists (select 1 from public.audit_log where entity_type='task_from_template' and entity_id=(select id from sec_state where key='from_template')) then raise exception 'FAIL SEC13 project provenance hidden'; end if;
end $$;
reset role;

-- One semantic audit owner: one task update, exactly two reorder events.
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from sec_state where key='owner'),true);
do $$ declare before_count integer; after_count integer; begin
  select count(*) into before_count from public.audit_log where entity_type='task' and entity_id=(select id from sec_state where key='task') and action='updated';
  perform public.update_task((select id from sec_state where key='task'),'Single audit update','one row');
  select count(*) into after_count from public.audit_log where entity_type='task' and entity_id=(select id from sec_state where key='task') and action='updated';
  if after_count-before_count <> 1 then raise exception 'FAIL SEC14 task update audit count=%',after_count-before_count; end if;
end $$;
do $$ declare before_reordered integer; after_reordered integer; before_updated integer; after_updated integer; begin
  select count(*) into before_reordered from public.audit_log where entity_type='task' and action='reordered';
  select count(*) into before_updated from public.audit_log where entity_type='task' and action='updated';
  perform public.move_task((select id from sec_state where key='task_two'),-1);
  select count(*) into after_reordered from public.audit_log where entity_type='task' and action='reordered';
  select count(*) into after_updated from public.audit_log where entity_type='task' and action='updated';
  if after_reordered-before_reordered <> 2 or after_updated <> before_updated then raise exception 'FAIL SEC15 reorder audit semantics'; end if;
end $$;
reset role;

-- Text limits are consistent in RPCs and table constraints.
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from sec_state where key='owner'),true);
select public.update_task((select id from sec_state where key='task'),repeat('T',500),repeat('D',10000));
select public.update_task_item((select id from sec_state where key='item'),repeat('I',500),repeat('D',10000));
select public.set_task_item_comment((select id from sec_state where key='item'),repeat('C',10000));
do $$ declare denied boolean:=false; begin
  begin perform public.update_task((select id from sec_state where key='task'),repeat('T',501),null); exception when others then denied:=true; end;
  if not denied then raise exception 'FAIL SEC16 task title >500'; end if;
  denied:=false;
  begin perform public.set_task_item_comment((select id from sec_state where key='item'),repeat('C',10001)); exception when others then denied:=true; end;
  if not denied then raise exception 'FAIL SEC16 comment >10000'; end if;
end $$;
reset role;
do $$ declare denied boolean:=false; begin
  begin update public.tasks set description=repeat('D',10001) where id=(select id from sec_state where key='task'); exception when check_violation then denied:=true; end;
  if not denied then raise exception 'FAIL SEC17 DB description constraint'; end if;
end $$;

-- Corrected catalog/grant/Realtime exposure.
do $$ declare n integer; begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proname='update_task_item';
  if n <> 1 then raise exception 'FAIL SEC18 update_task_item overload count=%',n; end if;
  if exists (
    select 1 from pg_publication_tables
     where pubname='supabase_realtime'
       and schemaname='public'
       and tablename in ('projects','project_members','tasks','task_members','task_assignees','task_items','item_actions','audit_log','notifications')
  ) then raise exception 'FAIL SEC19 application table remains in Postgres Changes'; end if;
  if has_table_privilege('service_role','public.projects','select')
     or has_table_privilege('service_role','public.projects','insert')
     or has_function_privilege('service_role','public.create_project(text,text)','execute') then
    raise exception 'FAIL SEC20 service_role exposure';
  end if;
  if has_function_privilege('anon','public.update_task_item(uuid,text,text,numeric)','execute') then raise exception 'FAIL SEC20 anon function exposure'; end if;
  if has_function_privilege('authenticated','private.is_project_member(uuid,uuid)','execute')
     or has_function_privilege('authenticated','private.has_task_access(uuid,uuid)','execute') then
    raise exception 'FAIL SEC20 arbitrary-subject helper exposure';
  end if;
  if to_regprocedure('public.audit_to_notification()') is not null then raise exception 'FAIL SEC20 orphan function remains'; end if;
  if not exists (select 1 from pg_indexes where schemaname='public' and tablename='task_templates' and indexdef like '%(created_by)%') then raise exception 'FAIL SEC21 creator FK index'; end if;
end $$;

rollback;
do $$ begin raise notice 'ALL CANONICAL RLS/RPC TESTS PASSED'; end $$;
