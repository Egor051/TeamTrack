-- TaskTrace — smoke tests for the initial schema migration.
-- Usage (validation only, NOT a migration):
--   docker run --name tt-sqlcheck -e POSTGRES_PASSWORD=postgres -d postgres:16-alpine
--   docker cp supabase/migrations/20260901000000_initial_schema.sql tt-sqlcheck:/tmp/
--   docker cp supabase/tests/initial_schema_smoke_test.sql tt-sqlcheck:/tmp/
--   docker exec tt-sqlcheck psql -U postgres -c "create schema auth; create table auth.users (id uuid primary key default gen_random_uuid(), email text);"
--   docker exec tt-sqlcheck psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/20260901000000_initial_schema.sql
--   docker exec tt-sqlcheck psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/initial_schema_smoke_test.sql
--   docker rm -f tt-sqlcheck
--
-- auth.users is stubbed (same shape Supabase uses for the id column).

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------- positive path
insert into auth.users (id, email)
values (gen_random_uuid(), 'alice@example.com'), (gen_random_uuid(), 'bob@example.com');

-- The full migration set provisions profiles automatically from auth.users.
-- Keep the smoke test compatible with both the baseline schema and that
-- trigger by making this explicit fixture idempotent.
insert into public.profiles (id, display_name)
select id, 'Alice' from auth.users where email = 'alice@example.com'
on conflict (id) do update set display_name = excluded.display_name;

insert into public.projects (name, description, created_by)
select 'Apollo', 'Test project', id from auth.users where email = 'alice@example.com';

insert into public.project_members (project_id, user_id, role)
select p.id, u.id, 'owner'
from public.projects p, auth.users u
where p.name = 'Apollo' and u.email = 'alice@example.com';

insert into public.tasks (project_id, title, created_by)
select p.id, 'Setup CI', u.id
from public.projects p, auth.users u
where p.name = 'Apollo' and u.email = 'alice@example.com';

insert into public.task_members (task_id, user_id, approved_by)
select t.id, u.id, t.created_by
from public.tasks t, auth.users u
where t.title = 'Setup CI' and u.email = 'bob@example.com';

insert into public.task_assignees (task_id, user_id, assigned_by)
select t.id, u.id, t.created_by
from public.tasks t, auth.users u
where t.title = 'Setup CI' and u.email = 'bob@example.com';

insert into public.task_items (task_id, title, position) values
    ((select id from public.tasks where title = 'Setup CI'), 'Create repo', 1),
    ((select id from public.tasks where title = 'Setup CI'), 'Add pipeline', 2);

-- fractional reorder insert between 1 and 2
insert into public.task_items (task_id, title, position)
select id, 'Write docs', 1.5 from public.tasks where title = 'Setup CI';

insert into public.item_actions (project_id, task_id, task_item_id, user_id, action)
select t.project_id, t.id, i.id, t.created_by, 'checked'
from public.tasks t
join public.task_items i on i.task_id = t.id
where t.title = 'Setup CI' and i.title = 'Create repo';

update public.task_items set is_completed = true
where title = 'Create repo';

insert into public.audit_log (project_id, user_id, action, entity_type, entity_id, old_data, new_data)
select t.project_id, t.created_by, 'updated', 'task_item', i.id,
       '{"is_completed": false}'::jsonb, '{"is_completed": true}'::jsonb
from public.tasks t
join public.task_items i on i.task_id = t.id
where t.title = 'Setup CI' and i.title = 'Create repo';

-- ---------------------------------------------------------------- negative tests

-- item_actions is append-only: UPDATE must fail
do $$
begin
    update public.item_actions set action = 'unchecked';
    raise exception 'FAIL: item_actions UPDATE was allowed';
exception
    when check_violation then null; -- expected
end $$;

-- audit_log is append-only: DELETE must fail
do $$
begin
    delete from public.audit_log;
    raise exception 'FAIL: audit_log DELETE was allowed';
exception
    when check_violation then null; -- expected
end $$;

-- item_actions TRUNCATE must fail
do $$
begin
    truncate public.item_actions;
    raise exception 'FAIL: item_actions TRUNCATE was allowed';
exception
    when check_violation then null; -- expected
end $$;

-- item_actions.project_id must match the task item's real project (composite FK)
do $$
declare v_other uuid;
begin
    insert into public.projects (name, created_by)
    select 'Other project', id from auth.users where email = 'alice@example.com'
    returning id into v_other;

    insert into public.item_actions (project_id, task_id, task_item_id, user_id, action)
    select v_other, i.task_id, i.id, t.created_by, 'checked'
    from public.task_items i
    join public.tasks t on t.id = i.task_id
    where i.title = 'Create repo';

    raise exception 'FAIL: mismatched project_id/task_item_id was allowed';
exception
    when foreign_key_violation then null; -- expected
end $$;

-- task_items archive consistency: archived_at without is_archived must fail
do $$
begin
    update public.task_items set archived_at = now() where title = 'Write docs';
    raise exception 'FAIL: archived_at without is_archived was allowed';
exception
    when check_violation then null; -- expected
end $$;

-- projects archive consistency: status archived without archived_at must fail
do $$
begin
    update public.projects set status = 'archived' where name = 'Apollo';
    raise exception 'FAIL: archived status without archived_at was allowed';
exception
    when check_violation then null; -- expected
end $$;

-- blank titles must fail
do $$
begin
    insert into public.task_items (task_id, title, position)
    select id, '   ', 3 from public.tasks where title = 'Setup CI';
    raise exception 'FAIL: blank title was allowed';
exception
    when check_violation then null; -- expected
end $$;

-- at most one owner per project
do $$
begin
    insert into public.project_members (project_id, user_id, role)
    select p.id, u.id, 'owner'
    from public.projects p, auth.users u
    where p.name = 'Apollo' and u.email = 'bob@example.com';
    raise exception 'FAIL: second owner was allowed';
exception
    when unique_violation then null; -- expected
end $$;

-- duplicate positions within one task must fail
do $$
begin
    insert into public.task_items (task_id, title, position)
    select id, 'Dup', 1.5 from public.tasks where title = 'Setup CI';
    raise exception 'FAIL: duplicate position was allowed';
exception
    when unique_violation then null; -- expected
end $$;

-- ordering values must be non-negative and must not be NaN
do $$
begin
    insert into public.task_items (task_id, title, position)
    select id, 'Negative position', -1 from public.tasks where title = 'Setup CI';
    raise exception 'FAIL: negative position was allowed';
exception
    when check_violation then null; -- expected
end $$;

do $$
begin
    insert into public.task_items (task_id, title, position)
    select id, 'NaN position', 'NaN'::numeric from public.tasks where title = 'Setup CI';
    raise exception 'FAIL: NaN position was allowed';
exception
    when check_violation then null; -- expected
end $$;

-- ---------------------------------------------------------------- history survives archiving

update public.projects set status = 'archived', archived_at = now() where name = 'Apollo';

do $$
declare v_count int;
begin
    select count(*) into v_count from public.item_actions;
    if v_count <> 1 then
        raise exception 'FAIL: item_actions rows lost after archiving (count=%)', v_count;
    end if;
    select count(*) into v_count from public.audit_log;
    if v_count <> 1 then
        raise exception 'FAIL: audit_log rows lost after archiving (count=%)', v_count;
    end if;
end $$;

-- ---------------------------------------------------------------- updated_at trigger

do $$
declare
    v_before timestamptz;
    v_after timestamptz;
begin
    select updated_at into v_before from public.tasks where title = 'Setup CI';
    perform pg_sleep(0.01);
    update public.tasks set description = 'updated' where title = 'Setup CI';
    select updated_at into v_after from public.tasks where title = 'Setup CI';
    if v_after = v_before then
        raise exception 'FAIL: updated_at trigger did not fire';
    end if;
end $$;

-- ---------------------------------------------------------------- summary

select 'item_actions rows' as check_name, count(*) as value from public.item_actions
union all
select 'audit_log rows', count(*) from public.audit_log
union all
select 'task_items rows', count(*) from public.task_items;

select new_data->>'is_completed' as audit_new_state from public.audit_log;

do $$
begin
    raise notice 'ALL SMOKE TESTS PASSED';
end $$;
