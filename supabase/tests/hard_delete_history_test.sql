-- Regression coverage for archived hard deletes and append-only history.
-- Run after the full migration set as the local postgres test administrator.
\set ON_ERROR_STOP on

begin;

create temp table hd_state (key text primary key, id uuid not null);
grant select, insert, update on hd_state to authenticated;

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data,
                        email_confirmed_at, created_at, updated_at, is_anonymous, is_sso_user)
values ('30000000-0000-0000-0000-000000000001', 'hard-delete-owner@test.local',
        'authenticated', 'authenticated', '{}', '{"display_name":"Hard Delete Owner"}',
        now(), now(), now(), false, false);
insert into hd_state values ('owner', '30000000-0000-0000-0000-000000000001');

set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from hd_state where key = 'owner'), true);

-- Test C: an archived checklist item can be deleted without mutating history.
insert into hd_state
select 'item_project', public.create_project('HD item project', null);
insert into hd_state
select 'item_task', public.create_task((select id from hd_state where key = 'item_project'), 'HD item task', null);
insert into hd_state
select 'item', public.create_task_item((select id from hd_state where key = 'item_task'), 'HD item', null);
select public.set_task_item_state((select id from hd_state where key = 'item'), true);
select public.archive_task_item((select id from hd_state where key = 'item'));
select public.hard_delete_task_item((select id from hd_state where key = 'item'));
reset role;

do $$
declare
    v_project uuid := (select id from hd_state where key = 'item_project');
    v_task uuid := (select id from hd_state where key = 'item_task');
    v_item uuid := (select id from hd_state where key = 'item');
begin
    if exists (select 1 from public.task_items where id = v_item) then
        raise exception 'FAIL HD-C: archived item still exists';
    end if;
    if not exists (select 1 from public.item_actions
                   where project_id = v_project and task_id = v_task and task_item_id = v_item) then
        raise exception 'FAIL HD-C: item_actions history was lost or rewritten';
    end if;
    if not exists (select 1 from public.audit_log
                   where project_id = v_project and entity_id = v_item and action = 'removed') then
        raise exception 'FAIL HD-C: item removed audit missing';
    end if;
    raise notice 'PASS HD-C: archived item deleted and immutable history retained';
end $$;

-- Test B: an archived task can be deleted while item/action/audit history stays intact.
set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from hd_state where key = 'owner'), true);
insert into hd_state
select 'task_project', public.create_project('HD task project', null);
insert into hd_state
select 'task', public.create_task((select id from hd_state where key = 'task_project'), 'HD task', null);
insert into hd_state
select 'task_item', public.create_task_item((select id from hd_state where key = 'task'), 'HD task item', null);
select public.set_task_item_state((select id from hd_state where key = 'task_item'), true);
select public.archive_task((select id from hd_state where key = 'task'));
select public.hard_delete_task((select id from hd_state where key = 'task'));
reset role;

do $$
declare
    v_project uuid := (select id from hd_state where key = 'task_project');
    v_task uuid := (select id from hd_state where key = 'task');
    v_item uuid := (select id from hd_state where key = 'task_item');
begin
    if exists (select 1 from public.tasks where id = v_task) then
        raise exception 'FAIL HD-B: archived task still exists';
    end if;
    if exists (select 1 from public.task_items where id = v_item) then
        raise exception 'FAIL HD-B: task child item still exists';
    end if;
    if not exists (select 1 from public.item_actions
                   where project_id = v_project and task_id = v_task and task_item_id = v_item) then
        raise exception 'FAIL HD-B: item_actions history was lost or rewritten';
    end if;
    if not exists (select 1 from public.audit_log
                   where project_id = v_project and entity_id = v_task and action = 'removed') then
        raise exception 'FAIL HD-B: task removed audit missing';
    end if;
    raise notice 'PASS HD-B: archived task deleted and immutable history retained';
end $$;

-- Test A: an archived project can be deleted and its removed audit row keeps
-- the deleted project UUID instead of being nulled by an FK action.
set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from hd_state where key = 'owner'), true);
insert into hd_state
select 'project', public.create_project('HD project', null);
insert into hd_state
select 'project_task', public.create_task((select id from hd_state where key = 'project'), 'HD project task', null);
insert into hd_state
select 'project_item', public.create_task_item((select id from hd_state where key = 'project_task'), 'HD project item', null);
select public.set_task_item_state((select id from hd_state where key = 'project_item'), true);
select public.archive_project((select id from hd_state where key = 'project'));
select public.hard_delete_project((select id from hd_state where key = 'project'));
reset role;

do $$
declare
    v_project uuid := (select id from hd_state where key = 'project');
    v_task uuid := (select id from hd_state where key = 'project_task');
    v_item uuid := (select id from hd_state where key = 'project_item');
begin
    if exists (select 1 from public.projects where id = v_project) then
        raise exception 'FAIL HD-A: archived project still exists';
    end if;
    if exists (select 1 from public.tasks where id = v_task) then
        raise exception 'FAIL HD-A: project task still exists';
    end if;
    if exists (select 1 from public.task_items where id = v_item) then
        raise exception 'FAIL HD-A: project checklist item still exists';
    end if;
    if not exists (select 1 from public.item_actions
                   where project_id = v_project and task_id = v_task and task_item_id = v_item) then
        raise exception 'FAIL HD-A: project item_actions history was lost or rewritten';
    end if;
    if not exists (select 1 from public.audit_log
                   where project_id = v_project and entity_type = 'project'
                     and entity_id = v_project and action = 'removed') then
        raise exception 'FAIL HD-A: removed project audit missing or project_id was nulled';
    end if;
    raise notice 'PASS HD-A: archived project deleted and UUID-bearing history retained';
end $$;

-- Active entities remain protected by the existing archived-only checks.
set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from hd_state where key = 'owner'), true);
insert into hd_state
select 'active_project', public.create_project('HD active project', null);
insert into hd_state
select 'active_task', public.create_task((select id from hd_state where key = 'active_project'), 'HD active task', null);
insert into hd_state
select 'active_item', public.create_task_item((select id from hd_state where key = 'active_task'), 'HD active item', null);
do $$
declare
    v_ok boolean;
begin
    begin perform public.hard_delete_project((select id from hd_state where key = 'active_project')); v_ok := true; exception when others then v_ok := false; end;
    if v_ok then raise exception 'FAIL HD-protection: active project hard delete allowed'; end if;
    begin perform public.hard_delete_task((select id from hd_state where key = 'active_task')); v_ok := true; exception when others then v_ok := false; end;
    if v_ok then raise exception 'FAIL HD-protection: active task hard delete allowed'; end if;
    begin perform public.hard_delete_task_item((select id from hd_state where key = 'active_item')); v_ok := true; exception when others then v_ok := false; end;
    if v_ok then raise exception 'FAIL HD-protection: active item hard delete allowed'; end if;
    raise notice 'PASS HD-protection: active project/task/item hard deletes rejected';
end $$;
reset role;

rollback;
do $$ begin raise notice 'ALL HARD DELETE HISTORY TESTS PASSED'; end $$;
