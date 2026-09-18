-- Stage rows are visible to every project member, independently of role or
-- task_members approval. Task-scoped mutations remain protected.
\set ON_ERROR_STOP on
begin;

create temp table stage_visibility_state (key text primary key, id uuid not null);
grant select, insert on stage_visibility_state to authenticated;

insert into auth.users (
    id, email, aud, role, raw_app_meta_data, raw_user_meta_data,
    email_confirmed_at, created_at, updated_at, is_anonymous, is_sso_user
)
values
    ('30000000-0000-0000-0000-000000000001', 'visibility-owner@test.local', 'authenticated', 'authenticated', '{}', '{}', now(), now(), now(), false, false),
    ('30000000-0000-0000-0000-000000000002', 'visibility-admin@test.local', 'authenticated', 'authenticated', '{}', '{}', now(), now(), now(), false, false),
    ('30000000-0000-0000-0000-000000000003', 'visibility-member@test.local', 'authenticated', 'authenticated', '{}', '{}', now(), now(), now(), false, false),
    ('30000000-0000-0000-0000-000000000004', 'visibility-viewer@test.local', 'authenticated', 'authenticated', '{}', '{}', now(), now(), now(), false, false),
    ('30000000-0000-0000-0000-000000000005', 'visibility-outsider@test.local', 'authenticated', 'authenticated', '{}', '{}', now(), now(), now(), false, false);

insert into stage_visibility_state values
    ('owner', '30000000-0000-0000-0000-000000000001'),
    ('admin', '30000000-0000-0000-0000-000000000002'),
    ('member', '30000000-0000-0000-0000-000000000003'),
    ('viewer', '30000000-0000-0000-0000-000000000004'),
    ('outsider', '30000000-0000-0000-0000-000000000005');

set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from stage_visibility_state where key = 'owner'), true);
insert into stage_visibility_state
select 'project', public.create_project('Visibility project', 'Project membership exposes every stage');
insert into stage_visibility_state
select 'existing_task', public.create_task(
    (select id from stage_visibility_state where key = 'project'),
    'Existing stage',
    'Created before the other project members were added'
);
select public.add_project_member(
    (select id from stage_visibility_state where key = 'project'),
    (select id from stage_visibility_state where key = 'admin'),
    'admin'
);
select public.add_project_member(
    (select id from stage_visibility_state where key = 'project'),
    (select id from stage_visibility_state where key = 'member'),
    'member'
);
select public.add_project_member(
    (select id from stage_visibility_state where key = 'project'),
    (select id from stage_visibility_state where key = 'viewer'),
    'viewer'
);
insert into stage_visibility_state
select 'existing_item', public.create_task_item(
    (select id from stage_visibility_state where key = 'existing_task'),
    'Owner-only checklist item'
);

do $$
declare
    v_task uuid := (select id from stage_visibility_state where key = 'existing_task');
    v_user uuid;
    v_count integer;
begin
    foreach v_user in array array[
        (select id from stage_visibility_state where key = 'owner'),
        (select id from stage_visibility_state where key = 'admin'),
        (select id from stage_visibility_state where key = 'member'),
        (select id from stage_visibility_state where key = 'viewer')
    ] loop
        perform set_config('request.jwt.claim.sub', v_user::text, true);
        select count(*) into v_count from public.tasks where id = v_task;
        if v_count <> 1 then
            raise exception 'project member cannot see existing stage';
        end if;
    end loop;

    perform set_config('request.jwt.claim.sub', (select id::text from stage_visibility_state where key = 'outsider'), true);
    select count(*) into v_count from public.tasks where id = v_task;
    if v_count <> 0 then
        raise exception 'outsider can see project stage';
    end if;
end
$$;

-- A stage created after membership is visible without creating task_members rows.
select set_config('request.jwt.claim.sub', (select id::text from stage_visibility_state where key = 'owner'), true);
insert into stage_visibility_state
select 'new_task', public.create_task(
    (select id from stage_visibility_state where key = 'project'),
    'New stage',
    'Created after project membership already existed'
);

do $$
declare
    v_task uuid := (select id from stage_visibility_state where key = 'new_task');
    v_user uuid;
    v_count integer;
begin
    foreach v_user in array array[
        (select id from stage_visibility_state where key = 'admin'),
        (select id from stage_visibility_state where key = 'member'),
        (select id from stage_visibility_state where key = 'viewer')
    ] loop
        perform set_config('request.jwt.claim.sub', v_user::text, true);
        select count(*) into v_count from public.tasks where id = v_task;
        if v_count <> 1 then
            raise exception 'project member cannot see newly created stage';
        end if;
        select count(*) into v_count
          from public.task_members
         where task_id = v_task and user_id = v_user;
        if v_count <> 0 then
            raise exception 'stage visibility created unexpected task_members access';
        end if;
    end loop;
end
$$;

-- Visibility does not grant task-scoped edit, archive, checklist or assignment rights.
select set_config('request.jwt.claim.sub', (select id::text from stage_visibility_state where key = 'member'), true);
do $$
declare
    v_task uuid := (select id from stage_visibility_state where key = 'existing_task');
    v_item uuid := (select id from stage_visibility_state where key = 'existing_item');
    v_member uuid := (select id from stage_visibility_state where key = 'member');
    v_count integer;
    v_denied boolean;
begin
    v_denied := false;
    begin
        update public.tasks set description = 'forbidden' where id = v_task;
        get diagnostics v_count = row_count;
        v_denied := v_count = 0;
    exception when insufficient_privilege then
        v_denied := true;
    end;
    if not v_denied then raise exception 'visible stage became directly editable without task access'; end if;

    select count(*) into v_count from public.task_items where id = v_item;
    if v_count <> 0 then
        raise exception 'task-scoped checklist became visible without task access';
    end if;

    v_denied := false;
    begin
        perform public.update_task(v_task, 'forbidden', null);
    exception when insufficient_privilege then
        v_denied := true;
    end;
    if not v_denied then raise exception 'member edited stage without task access'; end if;

    v_denied := false;
    begin
        perform public.archive_task(v_task);
    exception when insufficient_privilege then
        v_denied := true;
    end;
    if not v_denied then raise exception 'member archived stage'; end if;

    v_denied := false;
    begin
        perform public.add_task_assignee(v_task, v_member);
    exception when insufficient_privilege then
        v_denied := true;
    end;
    if not v_denied then raise exception 'member assigned a user'; end if;
end
$$;

select set_config('request.jwt.claim.sub', (select id::text from stage_visibility_state where key = 'viewer'), true);
do $$
declare
    v_item uuid := (select id from stage_visibility_state where key = 'existing_item');
    v_denied boolean := false;
begin
    begin
        perform public.set_task_item_state(v_item, true);
    exception when insufficient_privilege then
        v_denied := true;
    end;
    if not v_denied then raise exception 'viewer changed checklist state'; end if;
end
$$;

rollback;
do $$ begin raise notice 'ALL STAGE VISIBILITY TESTS PASSED'; end $$;
