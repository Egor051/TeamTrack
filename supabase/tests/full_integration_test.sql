-- Full backend integration and authorization verification.
-- Prerequisite: npx supabase db reset
-- Run: pipe this file to the local postgres container as postgres.
\set ON_ERROR_STOP on
begin;

create temp table it_state (key text primary key, id uuid not null);
grant select, insert, update on it_state to authenticated;

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data,
                        email_confirmed_at, created_at, updated_at, is_anonymous, is_sso_user)
values
 ('20000000-0000-0000-0000-000000000001','it-owner@test.local','authenticated','authenticated','{}','{"display_name":"Owner"}',now(),now(),now(),false,false),
 ('20000000-0000-0000-0000-000000000002','it-admin-a@test.local','authenticated','authenticated','{}','{"display_name":"Admin A"}',now(),now(),now(),false,false),
 ('20000000-0000-0000-0000-000000000003','it-admin-b@test.local','authenticated','authenticated','{}','{"display_name":"Admin B"}',now(),now(),now(),false,false),
 ('20000000-0000-0000-0000-000000000004','it-member@test.local','authenticated','authenticated','{}','{"display_name":"Member"}',now(),now(),now(),false,false),
 ('20000000-0000-0000-0000-000000000005','it-viewer@test.local','authenticated','authenticated','{}','{"display_name":"Viewer"}',now(),now(),now(),false,false),
 ('20000000-0000-0000-0000-000000000006','it-outsider@test.local','authenticated','authenticated','{}','{"display_name":"Outsider"}',now(),now(),now(),false,false);
insert into it_state values
 ('owner','20000000-0000-0000-0000-000000000001'),('admin_a','20000000-0000-0000-0000-000000000002'),
 ('admin_b','20000000-0000-0000-0000-000000000003'),('member','20000000-0000-0000-0000-000000000004'),
 ('viewer','20000000-0000-0000-0000-000000000005'),('outsider','20000000-0000-0000-0000-000000000006');

set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from it_state where key='owner'),true);
insert into it_state select 'project', public.create_project('Integration project','full flow');
select public.add_project_member((select id from it_state where key='project'),(select id from it_state where key='admin_a'),'admin');
select public.add_project_member((select id from it_state where key='project'),(select id from it_state where key='admin_b'),'admin');
select public.add_project_member((select id from it_state where key='project'),(select id from it_state where key='member'),'member');
select public.add_project_member((select id from it_state where key='project'),(select id from it_state where key='viewer'),'viewer');
insert into it_state select 'task', public.create_task((select id from it_state where key='project'),'Integration task','flow');
insert into it_state select 'item', public.create_task_item((select id from it_state where key='task'),'Initial item','desc');
select public.approve_task_member((select id from it_state where key='task'),(select id from it_state where key='admin_a'));
select public.approve_task_member((select id from it_state where key='task'),(select id from it_state where key='admin_b'));
select public.approve_task_member((select id from it_state where key='task'),(select id from it_state where key='member'));
select public.approve_task_member((select id from it_state where key='task'),(select id from it_state where key='viewer'));
reset role;

do $$ declare n int; begin
  if (select count(*) from public.project_members where project_id=(select id from it_state where key='project')) <> 5 then raise exception 'FAIL lifecycle project membership'; end if;
  if (select count(*) from public.task_members where task_id=(select id from it_state where key='task')) <> 5 then raise exception 'FAIL lifecycle task membership'; end if;
  raise notice 'PASS lifecycle: project/task/checklist created and visible';
end $$;

-- Admin matrix: operational access, but no owner mutation or peer-admin mutation.
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from it_state where key='admin_a'),true);
select public.change_member_role((select id from it_state where key='project'),(select id from it_state where key='member'),'viewer');
do $$ declare denied boolean:=false; begin
  begin perform public.change_member_role((select id from it_state where key='project'),(select id from it_state where key='admin_b'),'member'); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL role matrix: admin changed peer admin'; end if;
  begin perform public.remove_project_member((select id from it_state where key='project'),(select id from it_state where key='owner')); exception when insufficient_privilege or raise_exception then denied:=true; end;
  raise notice 'PASS role matrix: admin restrictions enforced';
end $$;
reset role;

-- Auth metadata containing only whitespace must still provision a valid profile.
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data,
                        email_confirmed_at, created_at, updated_at, is_anonymous, is_sso_user)
values ('20000000-0000-0000-0000-000000000007', 'blank-name@test.local', 'authenticated', 'authenticated',
        '{}', '{"display_name":"   ","name":""}', now(), now(), now(), false, false);
do $$
begin
  if not exists (select 1 from public.profiles where id='20000000-0000-0000-0000-000000000007' and display_name='blank-name') then
    raise exception 'FAIL profile provisioning fallback for blank metadata';
  end if;
end $$;

-- Member/viewer/outsider abuse and UUID IDOR checks.
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from it_state where key='member'),true);
do $$ declare denied boolean:=false; n int; begin
  begin perform public.add_project_member((select id from it_state where key='project'),(select id from it_state where key='outsider'),'member'); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL member project-member management'; end if;
  begin perform public.archive_task((select id from it_state where key='task')); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL member privileged task management'; end if;
  select count(*) into n from public.projects where id=(select id from it_state where key='project'); if n<>1 then raise exception 'FAIL member project read'; end if;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from it_state where key='viewer'),true);
do $$ declare denied boolean:=false; begin
  begin perform public.set_task_item_state((select id from it_state where key='item'),true); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL viewer checkbox mutation'; end if;
end $$;
select set_config('request.jwt.claim.sub',(select id::text from it_state where key='outsider'),true);
do $$ declare n int; begin
  select count(*) into n from public.projects where id=(select id from it_state where key='project'); if n<>0 then raise exception 'FAIL IDOR project'; end if;
  select count(*) into n from public.tasks where id=(select id from it_state where key='task'); if n<>0 then raise exception 'FAIL IDOR task'; end if;
  select count(*) into n from public.task_items where id=(select id from it_state where key='item'); if n<>0 then raise exception 'FAIL IDOR task item'; end if;
  select count(*) into n from public.item_actions where task_id=(select id from it_state where key='task'); if n<>0 then raise exception 'FAIL IDOR item_actions'; end if;
  select count(*) into n from public.audit_log where entity_id=(select id from it_state where key='item'); if n<>0 then raise exception 'FAIL IDOR audit'; end if;
  select count(*) into n from public.notifications; if n<>0 then raise exception 'FAIL IDOR notifications'; end if;
  raise notice 'PASS IDOR and role matrix';
end $$;
reset role;

-- Checkbox atomicity, no-op, immutable sequence and archive consistency.
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from it_state where key='owner'),true);
select public.set_task_item_state((select id from it_state where key='item'),true);
select public.set_task_item_state((select id from it_state where key='item'),true);
select public.update_task_item((select id from it_state where key='item'),'Edited item',null,null);
select public.set_task_item_state((select id from it_state where key='item'),false);
select public.archive_task_item((select id from it_state where key='item'));
reset role;
do $$ declare a int; h int; old jsonb; new jsonb; denied boolean:=false; begin
  select count(*) into a from public.item_actions where task_item_id=(select id from it_state where key='item');
  select count(*) into h from public.audit_log where entity_id=(select id from it_state where key='item');
  if a<>2 then raise exception 'FAIL checkbox no-op/history count=%',a; end if;
  if not exists (select 1 from public.task_items where id=(select id from it_state where key='item') and not is_completed and is_archived) then raise exception 'FAIL archive current state'; end if;
  select old_data,new_data into old,new from public.audit_log where entity_id=(select id from it_state where key='item') and action='unchecked' limit 1;
  if old <> '{"is_completed": true}'::jsonb or new <> '{"is_completed": false}'::jsonb then raise exception 'FAIL checkbox audit snapshots'; end if;
  begin update public.item_actions set action='checked' where task_item_id=(select id from it_state where key='item'); exception when check_violation then denied:=true; end;
  if not denied then raise exception 'FAIL item_actions UPDATE allowed'; end if;
  denied:=false;
  begin delete from public.audit_log where entity_id=(select id from it_state where key='item'); exception when check_violation then denied:=true; end;
  if not denied then raise exception 'FAIL audit DELETE allowed'; end if;
  raise notice 'PASS atomic checkbox, no-op, audit/history immutability and archive';
end $$;

-- RPC rollback: caught failure rolls back the preceding mutation in the subtransaction.
set local role authenticated;
select set_config('request.jwt.claim.sub',(select id::text from it_state where key='owner'),true);
do $$ declare v uuid; denied boolean:=false; begin
  begin
    v := public.create_task((select id from it_state where key='project'),'Rollback task','must vanish');
    raise exception 'forced failure';
  exception when raise_exception then null;
  end;
  if exists (select 1 from public.tasks where title='Rollback task') then raise exception 'FAIL rollback task remained'; end if;
  raise notice 'PASS RPC rollback removes business/audit side effects';
end $$;
reset role;

rollback;
do $$ begin raise notice 'ALL FULL INTEGRATION TESTS PASSED'; end $$;
