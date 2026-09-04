-- TaskTrace — RLS & RPC security tests (migration 0002).
-- Usage (validation only, NOT a migration):
--   docker run --name tt-sqlcheck -e POSTGRES_PASSWORD=postgres -d postgres:16-alpine
--   docker cp supabase/migrations/20260901000000_initial_schema.sql tt-sqlcheck:/tmp/
--   docker cp supabase/migrations/20260902000000_rls_authorization.sql tt-sqlcheck:/tmp/
--   docker cp supabase/tests/initial_schema_smoke_test.sql tt-sqlcheck:/tmp/
--   docker cp supabase/tests/rls_and_rpc_test.sql tt-sqlcheck:/tmp/
--   docker exec tt-sqlcheck psql -U postgres -c "create schema auth; create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb not null default '{}'::jsonb); create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;"
--   docker exec tt-sqlcheck psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/20260901000000_initial_schema.sql
--   docker exec tt-sqlcheck psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/initial_schema_smoke_test.sql
--   docker exec tt-sqlcheck psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/20260902000000_rls_authorization.sql
--   docker exec tt-sqlcheck psql -v ON_ERROR_STOP=1 -U postgres -f /tmp/rls_and_rpc_test.sql
--   docker rm -f tt-sqlcheck
--
-- The runner session is superuser (bypasses RLS). Every test block switches
-- the role to `authenticated` and injects a JWT `sub` claim, which is exactly
-- how Supabase/PostgREST presents callers. Assertions check actual outcomes
-- (row counts / state), not merely the absence of SQL errors.

\set ON_ERROR_STOP on

-- =============================================================== seed (superuser)

insert into auth.users (
    id, email, aud, role, raw_app_meta_data, raw_user_meta_data,
    email_confirmed_at, created_at, updated_at, is_anonymous, is_sso_user
)
select
    gen_random_uuid(), e, 'authenticated', 'authenticated',
    '{}'::jsonb, '{}'::jsonb, now(), now(), now(), false, false
from (values
    ('alice@example.com'), -- owner of P1
    ('bob@example.com'),   -- admin of P1
    ('carol@example.com'), -- member of P1
    ('dave@example.com'),  -- viewer of P1
    ('eve@example.com'),   -- outsider
    ('frank@example.com')  -- member of P1, initially without task access
) s(e)
where not exists (select 1 from auth.users u where u.email = s.e);

create temp table tt_state (k text primary key, v text not null);

-- one row per user even if the smoke test already created some of them
insert into tt_state (k, v)
select k, (min(id::text))::uuid::text
from (
    select 'u_' || split_part(email, '@', 1) as k, id from auth.users
) s
group by k;

grant select, insert, update, delete on tt_state to authenticated;

-- =============================================================== setup via RPCs

-- P-setup: owner creates project; owner adds admin/member/viewer/member
do $$
declare
    v_proj uuid;
    v_alice uuid := (select v::uuid from tt_state where k = 'u_alice');
    v_bob   uuid := (select v::uuid from tt_state where k = 'u_bob');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_dave  uuid := (select v::uuid from tt_state where k = 'u_dave');
    v_frank uuid := (select v::uuid from tt_state where k = 'u_frank');
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_alice::text, true);

    v_proj := public.create_project('Apollo', 'RLS test project');
    insert into tt_state values ('proj', v_proj::text);

    perform public.add_project_member(v_proj, v_bob, 'admin');
    perform public.add_project_member(v_proj, v_carol, 'member');
    perform public.add_project_member(v_proj, v_dave, 'viewer');
    perform public.add_project_member(v_proj, v_frank, 'member');
end $$;

-- P1-P4: owner/admin/member/viewer read the project
do $$
declare
    v_proj uuid := (select v::uuid from tt_state where k = 'proj');
    v_cnt int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', (select v from tt_state where k = 'u_alice'), true);
    select count(*) into v_cnt from public.projects where id = v_proj;
    if v_cnt <> 1 then raise exception 'FAIL P1: owner cannot read project'; end if;

    perform set_config('request.jwt.claim.sub', (select v from tt_state where k = 'u_bob'), true);
    select count(*) into v_cnt from public.projects where id = v_proj;
    if v_cnt <> 1 then raise exception 'FAIL P2: admin cannot read project'; end if;

    perform set_config('request.jwt.claim.sub', (select v from tt_state where k = 'u_carol'), true);
    select count(*) into v_cnt from public.projects where id = v_proj;
    if v_cnt <> 1 then raise exception 'FAIL P3: member cannot read project'; end if;

    perform set_config('request.jwt.claim.sub', (select v from tt_state where k = 'u_dave'), true);
    select count(*) into v_cnt from public.projects where id = v_proj;
    if v_cnt <> 1 then raise exception 'FAIL P4: viewer cannot read project'; end if;

    -- outsider sees nothing
    perform set_config('request.jwt.claim.sub', (select v from tt_state where k = 'u_eve'), true);
    select count(*) into v_cnt from public.projects;
    if v_cnt <> 0 then raise exception 'FAIL: outsider sees projects'; end if;
end $$;

-- P6/P7: member creates task; creator automatically becomes task member
do $$
declare
    v_proj uuid := (select v::uuid from tt_state where k = 'proj');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_t1 uuid; v_cnt int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_carol::text, true);

    v_t1 := public.create_task(v_proj, 'Setup CI', 'checklist task');
    insert into tt_state values ('t1', v_t1::text);

    select count(*) into v_cnt from public.task_members
    where task_id = v_t1 and user_id = v_carol;
    if v_cnt <> 1 then raise exception 'FAIL P7: creator did not receive task membership'; end if;
end $$;

-- items on T1
do $$
declare
    v_t1 uuid := (select v::uuid from tt_state where k = 't1');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_i1 uuid; v_i2 uuid;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_carol::text, true);

    v_i1 := public.create_task_item(v_t1, 'Create repo');
    v_i2 := public.create_task_item(v_t1, 'Add pipeline');
    insert into tt_state values ('i1', v_i1::text), ('i2', v_i2::text);
end $$;

-- N6/N7/N8: user without a task_members row sees no task / items / item_actions
do $$
declare
    v_t1 uuid := (select v::uuid from tt_state where k = 't1');
    v_cnt int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', (select v from tt_state where k = 'u_frank'), true);

    select count(*) into v_cnt from public.tasks where id = v_t1;
    if v_cnt <> 0 then raise exception 'FAIL N6: frank sees task without task_members'; end if;
    select count(*) into v_cnt from public.task_items where task_id = v_t1;
    if v_cnt <> 0 then raise exception 'FAIL N7: frank sees task items without access'; end if;
    select count(*) into v_cnt from public.item_actions where task_id = v_t1;
    if v_cnt <> 0 then raise exception 'FAIL N8: frank sees item_actions without access'; end if;
end $$;

-- N8b: project member without task access cannot read task-scoped audit rows.
do $$
declare
    v_proj uuid;
    v_cnt int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', (select v from tt_state where k = 'u_frank'), true);
    select count(*) into v_cnt
      from public.audit_log
     where project_id = v_proj
       and entity_type in ('task', 'task_item', 'task_member', 'task_assignee');
    if v_cnt <> 0 then raise exception 'FAIL N8b: frank sees task-scoped audit rows (cnt=%)', v_cnt; end if;
end $$;

-- N8c: profile visibility is limited to self and users sharing a project.
do $$
declare
    v_proj uuid := (select v::uuid from tt_state where k = 'proj');
    v_frank uuid := (select v::uuid from tt_state where k = 'u_frank');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_dave uuid := (select v::uuid from tt_state where k = 'u_dave');
    v_eve uuid := (select v::uuid from tt_state where k = 'u_eve');
    v_cnt int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_frank::text, true);

    select count(*) into v_cnt from public.profiles where id = v_frank;
    if v_cnt <> 1 then raise exception 'FAIL N8c: user cannot read own profile'; end if;

    select count(*) into v_cnt from public.profiles where id = v_carol;
    if v_cnt <> 1 then raise exception 'FAIL N8c: shared-project profile is hidden'; end if;

    select count(*) into v_cnt from public.profiles where id = v_eve;
    if v_cnt <> 0 then raise exception 'FAIL N8c: unrelated profile is visible'; end if;

    perform set_config('request.jwt.claim.sub', v_eve::text, true);
    select count(*) into v_cnt from public.profiles where id = v_eve;
    if v_cnt <> 1 then raise exception 'FAIL N8c: user cannot read own profile as outsider'; end if;
end $$;

-- N8d: private authorization helpers are not directly callable by clients.
do $$
declare
    v_t1 uuid := (select v::uuid from tt_state where k = 't1');
    v_denied boolean := false;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', (select v from tt_state where k = 'u_frank'), true);
    begin
        perform private.task_project_id(v_t1);
    exception when insufficient_privilege then
        v_denied := true;
    end;
    if not v_denied then raise exception 'FAIL N8d: private.task_project_id is callable by authenticated'; end if;
end $$;

-- P5/P8/P9: owner and admin approve task members; approved member reads task
do $$
declare
    v_proj uuid := (select v::uuid from tt_state where k = 'proj');
    v_t1   uuid := (select v::uuid from tt_state where k = 't1');
    v_alice uuid := (select v::uuid from tt_state where k = 'u_alice');
    v_bob   uuid := (select v::uuid from tt_state where k = 'u_bob');
    v_dave  uuid := (select v::uuid from tt_state where k = 'u_dave');
    v_frank uuid := (select v::uuid from tt_state where k = 'u_frank');
    v_cnt int;
begin
    perform set_config('role', 'authenticated', true);

    perform set_config('request.jwt.claim.sub', v_alice::text, true);
    perform public.approve_task_member(v_t1, v_dave);

    perform set_config('request.jwt.claim.sub', v_bob::text, true);
    perform public.approve_task_member(v_t1, v_frank);

    perform set_config('request.jwt.claim.sub', v_dave::text, true);
    select count(*) into v_cnt from public.tasks where id = v_t1;
    if v_cnt <> 1 then raise exception 'FAIL P5: approved task member cannot read task'; end if;
    select count(*) into v_cnt from public.project_members where project_id = v_proj;
    if v_cnt <> 5 then raise exception 'FAIL: project member cannot read project_members (cnt=%)', v_cnt; end if;
end $$;

-- P10: owner/admin add assignees (assignee must be project member AND task member)
do $$
declare
    v_t1 uuid := (select v::uuid from tt_state where k = 't1');
    v_alice uuid := (select v::uuid from tt_state where k = 'u_alice');
    v_bob   uuid := (select v::uuid from tt_state where k = 'u_bob');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_frank uuid := (select v::uuid from tt_state where k = 'u_frank');
    v_cnt int;
begin
    perform set_config('role', 'authenticated', true);

    perform set_config('request.jwt.claim.sub', v_alice::text, true);
    perform public.add_task_assignee(v_t1, v_carol);

    perform set_config('request.jwt.claim.sub', v_bob::text, true);
    perform public.add_task_assignee(v_t1, v_frank);

    -- count as carol: she is a task member, so task_assignees is visible to her
    perform set_config('request.jwt.claim.sub', v_carol::text, true);
    select count(*) into v_cnt from public.task_assignees where task_id = v_t1;
    if v_cnt <> 2 then raise exception 'FAIL P10: assignees not added (cnt=%)', v_cnt; end if;
end $$;

-- P11-P14: checkbox RPC; item_actions + audit_log created; idempotent repeat
do $$
declare
    v_i1  uuid := (select v::uuid from tt_state where k = 'i1');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_res boolean;
    v_completed boolean;
    v_acts int; v_audits int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_carol::text, true);

    v_res := public.set_task_item_state(v_i1, true);
    if v_res is not true then raise exception 'FAIL P11: set_task_item_state returned %', v_res; end if;

    select is_completed into v_completed from public.task_items where id = v_i1;
    if v_completed is not true then raise exception 'FAIL P11: is_completed not updated'; end if;

    select count(*) into v_acts from public.item_actions
    where task_item_id = v_i1 and action = 'checked' and user_id = v_carol;
    if v_acts <> 1 then raise exception 'FAIL P12: item_actions row missing (cnt=%)', v_acts; end if;

    select count(*) into v_audits from public.audit_log
    where entity_type = 'task_item' and entity_id = v_i1 and action = 'checked'
      and user_id = v_carol
      and old_data = '{"is_completed": false}'::jsonb
      and new_data = '{"is_completed": true}'::jsonb;
    if v_audits <> 1 then raise exception 'FAIL P13: audit_log row missing/incorrect (cnt=%)', v_audits; end if;

    -- P14: repeated set(true) is a no-op
    v_res := public.set_task_item_state(v_i1, true);
    select count(*) into v_acts from public.item_actions where task_item_id = v_i1;
    if v_acts <> 1 then raise exception 'FAIL P14: repeated set(true) created a second event (cnt=%)', v_acts; end if;
    select count(*) into v_audits from public.audit_log
    where entity_id = v_i1 and action = 'checked';
    if v_audits <> 1 then raise exception 'FAIL P14: repeated set(true) created a second audit row (cnt=%)', v_audits; end if;

    -- uncheck produces the opposite event
    v_res := public.set_task_item_state(v_i1, false);
    select count(*) into v_acts from public.item_actions where task_item_id = v_i1;
    if v_acts <> 2 then raise exception 'FAIL: uncheck did not create event (cnt=%)', v_acts; end if;
end $$;

-- last-write-wins sequence: carol checks, frank unchecks -> state false, both events
do $$
declare
    v_i1 uuid := (select v::uuid from tt_state where k = 'i1');
    v_completed boolean;
begin
    perform set_config('role', 'authenticated', true);

    perform set_config('request.jwt.claim.sub', (select v from tt_state where k = 'u_carol'), true);
    perform public.set_task_item_state(v_i1, true);

    perform set_config('request.jwt.claim.sub', (select v from tt_state where k = 'u_frank'), true);
    perform public.set_task_item_state(v_i1, false);

    select is_completed into v_completed from public.task_items where id = v_i1;
    if v_completed is not false then raise exception 'FAIL: last write did not win'; end if;
end $$;

-- second task T2 (owned by alice) for negative approve/assignee tests
do $$
declare
    v_proj uuid := (select v::uuid from tt_state where k = 'proj');
    v_alice uuid := (select v::uuid from tt_state where k = 'u_alice');
    v_t2 uuid;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_alice::text, true);
    v_t2 := public.create_task(v_proj, 'Deploy');
    insert into tt_state values ('t2', v_t2::text);
end $$;

-- =============================================================== negative tests

-- N1: viewer cannot update task (RLS row-level: 0 rows affected)
do $$
declare
    v_t1 uuid := (select v::uuid from tt_state where k = 't1');
    v_title text;
    v_ok boolean := false;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', (select v from tt_state where k = 'u_dave'), true);

    begin
        update public.tasks set description = 'hacked' where id = v_t1;
    exception when insufficient_privilege or raise_exception then v_ok := true; end;

    select title into v_title from public.tasks where id = v_t1;
    if v_title <> 'Setup CI' then raise exception 'FAIL N1: viewer modified the task'; end if;
end $$;

-- N2: viewer cannot change checkbox
do $$
declare
    v_i1 uuid := (select v::uuid from tt_state where k = 'i1');
    v_dave uuid := (select v::uuid from tt_state where k = 'u_dave');
    v_ok boolean := false;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_dave::text, true);
    begin
        perform public.set_task_item_state(v_i1, true);
    exception when insufficient_privilege or raise_exception then
        v_ok := true;
    end;
    if not v_ok then raise exception 'FAIL N2: viewer changed checkbox'; end if;
end $$;

-- N3: member cannot change project members
do $$
declare
    v_proj uuid := (select v::uuid from tt_state where k = 'proj');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_dave  uuid := (select v::uuid from tt_state where k = 'u_dave');
    v_eve   uuid := (select v::uuid from tt_state where k = 'u_eve');
    v_ok boolean := false; v_cnt int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_carol::text, true);

    begin
        perform public.change_member_role(v_proj, v_dave, 'member');
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N3a: member changed a role'; end if;

    v_ok := false;
    begin
        perform public.add_project_member(v_proj, v_eve, 'member');
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N3b: member added a project member'; end if;

    perform set_config('request.jwt.claim.sub', (select v from tt_state where k = 'u_alice'), true);
    select count(*) into v_cnt from public.project_members where project_id = v_proj;
    if v_cnt <> 5 then raise exception 'FAIL N3: project members were modified (cnt=%)', v_cnt; end if;
end $$;

-- N4: member cannot approve task member
do $$
declare
    v_t2 uuid := (select v::uuid from tt_state where k = 't2');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_dave  uuid := (select v::uuid from tt_state where k = 'u_dave');
    v_ok boolean := false; v_cnt int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_carol::text, true);
    begin
        perform public.approve_task_member(v_t2, v_dave);
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N4: member approved a task member'; end if;

    perform set_config('request.jwt.claim.sub', (select v from tt_state where k = 'u_alice'), true);
    select count(*) into v_cnt from public.task_members where task_id = v_t2 and user_id = v_dave;
    if v_cnt <> 0 then raise exception 'FAIL N4: task membership was created by member'; end if;
end $$;

-- N5: member cannot add assignee
do $$
declare
    v_t1 uuid := (select v::uuid from tt_state where k = 't1');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_dave  uuid := (select v::uuid from tt_state where k = 'u_dave');
    v_ok boolean := false; v_cnt int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_carol::text, true);
    begin
        perform public.add_task_assignee(v_t1, v_dave);
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N5: member added an assignee'; end if;

    perform set_config('request.jwt.claim.sub', (select v from tt_state where k = 'u_alice'), true);
    select count(*) into v_cnt from public.task_assignees
    where task_id = v_t1 and user_id = v_dave;
    if v_cnt <> 0 then raise exception 'FAIL N5: assignee was added by member'; end if;
end $$;

-- N9: cannot assign a user without task access (project member, not task member)
do $$
declare
    v_t2 uuid := (select v::uuid from tt_state where k = 't2');
    v_alice uuid := (select v::uuid from tt_state where k = 'u_alice');
    v_frank uuid := (select v::uuid from tt_state where k = 'u_frank');
    v_ok boolean := false; v_cnt int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_alice::text, true);
    begin
        perform public.add_task_assignee(v_t2, v_frank);
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N9: assignee without task access was allowed'; end if;

    select count(*) into v_cnt from public.task_assignees where task_id = v_t2;
    if v_cnt <> 0 then raise exception 'FAIL N9: assignee row created'; end if;
end $$;

-- N10: cannot grant task access to a user without project membership
do $$
declare
    v_t1 uuid := (select v::uuid from tt_state where k = 't1');
    v_alice uuid := (select v::uuid from tt_state where k = 'u_alice');
    v_eve   uuid := (select v::uuid from tt_state where k = 'u_eve');
    v_ok boolean := false; v_cnt int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_alice::text, true);
    begin
        perform public.approve_task_member(v_t1, v_eve);
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N10: task access granted to non project member'; end if;

    select count(*) into v_cnt from public.task_members where user_id = v_eve;
    if v_cnt <> 0 then raise exception 'FAIL N10: task_members row created for outsider'; end if;
end $$;

-- N27: user without project membership cannot create a task
do $$
declare
    v_proj uuid := (select v::uuid from tt_state where k = 'proj');
    v_eve uuid := (select v::uuid from tt_state where k = 'u_eve');
    v_ok boolean := false; v_cnt int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_eve::text, true);
    begin
        perform public.create_task(v_proj, 'Intrusion');
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N27: outsider created a task'; end if;

    perform set_config('request.jwt.claim.sub', (select v from tt_state where k = 'u_alice'), true);
    select count(*) into v_cnt from public.tasks where project_id = v_proj and title = 'Intrusion';
    if v_cnt <> 0 then raise exception 'FAIL N27: task was created'; end if;
end $$;

-- P/N revoke: admin revokes frank's access; assignee row removed atomically
do $$
declare
    v_t1 uuid := (select v::uuid from tt_state where k = 't1');
    v_bob uuid := (select v::uuid from tt_state where k = 'u_bob');
    v_frank uuid := (select v::uuid from tt_state where k = 'u_frank');
    v_cnt int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_bob::text, true);
    perform public.revoke_task_member(v_t1, v_frank);

    select count(*) into v_cnt from public.task_members
    where task_id = v_t1 and user_id = v_frank;
    if v_cnt <> 0 then raise exception 'FAIL: task_members not removed'; end if;
    select count(*) into v_cnt from public.task_assignees
    where task_id = v_t1 and user_id = v_frank;
    if v_cnt <> 0 then raise exception 'FAIL: assignee not removed on revoke'; end if;

    -- Bob manages the task as project admin but intentionally has no
    -- task_members row, so scoped audit RLS hides this row from him. Switch
    -- back to the original postgres test session to prove the RPC inserted it.
    perform set_config('role', 'postgres', true);
    select count(*) into v_cnt from public.audit_log
    where entity_type = 'task_member' and entity_id = v_frank and action = 'access_revoked';
    if v_cnt <> 1 then raise exception 'FAIL: access_revoked audit missing'; end if;
end $$;

-- N11-N14: admin cannot change another admin / owner roles, cannot transfer,
--          cannot remove owner
do $$
declare
    v_proj uuid := (select v::uuid from tt_state where k = 'proj');
    v_alice uuid := (select v::uuid from tt_state where k = 'u_alice');
    v_bob   uuid := (select v::uuid from tt_state where k = 'u_bob');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_dave  uuid := (select v::uuid from tt_state where k = 'u_dave');
    v_role public.project_role;
    v_ok boolean := false;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_alice::text, true);

    -- temporarily promote carol to admin (owner action — positive)
    perform public.change_member_role(v_proj, v_carol, 'admin');
    select role into v_role from public.project_members
    where project_id = v_proj and user_id = v_carol;
    if v_role <> 'admin' then raise exception 'FAIL: owner could not promote member'; end if;

    -- N11: bob (admin) cannot change carol's (another admin) role
    perform set_config('request.jwt.claim.sub', v_bob::text, true);
    begin
        perform public.change_member_role(v_proj, v_carol, 'viewer');
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N11: admin changed another admin role'; end if;

    -- N12: bob (admin) cannot transfer ownership
    v_ok := false;
    begin
        perform public.transfer_project_ownership(v_proj, v_dave);
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N12: admin transferred ownership'; end if;

    -- N13: bob (admin) cannot change owner's role
    v_ok := false;
    begin
        perform public.change_member_role(v_proj, v_alice, 'admin');
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N13: admin changed owner role'; end if;

    -- N14: owner cannot be removed
    v_ok := false;
    begin
        perform public.remove_project_member(v_proj, v_alice);
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N14: owner was removed'; end if;

    -- restore carol to member (owner action)
    perform set_config('request.jwt.claim.sub', v_alice::text, true);
    perform public.change_member_role(v_proj, v_carol, 'member');
    select role into v_role from public.project_members
    where project_id = v_proj and user_id = v_carol;
    if v_role <> 'member' then raise exception 'FAIL: role not restored'; end if;
end $$;

-- P15: ownership transfer changes roles atomically (second project)
do $$
declare
    v_p2 uuid;
    v_alice uuid := (select v::uuid from tt_state where k = 'u_alice');
    v_bob   uuid := (select v::uuid from tt_state where k = 'u_bob');
    v_r_alice public.project_role;
    v_r_bob   public.project_role;
    v_cnt int;
begin
    perform set_config('role', 'authenticated', true);

    perform set_config('request.jwt.claim.sub', v_alice::text, true);
    v_p2 := public.create_project('Orion', null);
    insert into tt_state values ('p2', v_p2::text);
    perform public.add_project_member(v_p2, v_bob, 'admin');

    perform public.transfer_project_ownership(v_p2, v_bob);

    select role into v_r_bob from public.project_members
    where project_id = v_p2 and user_id = v_bob;
    select role into v_r_alice from public.project_members
    where project_id = v_p2 and user_id = v_alice;
    if v_r_bob <> 'owner' or v_r_alice <> 'admin' then
        raise exception 'FAIL P15: transfer produced wrong roles (%/%)', v_r_alice, v_r_bob;
    end if;
    select count(*) into v_cnt from public.project_members
    where project_id = v_p2 and role = 'owner';
    if v_cnt <> 1 then raise exception 'FAIL P15: project has % owners', v_cnt; end if;
end $$;

-- N12b/N13b: alice (now admin in P2) cannot transfer ownership or change owner role
do $$
declare
    v_p2 uuid := (select v::uuid from tt_state where k = 'p2');
    v_alice uuid := (select v::uuid from tt_state where k = 'u_alice');
    v_bob   uuid := (select v::uuid from tt_state where k = 'u_bob');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_ok boolean := false;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_alice::text, true);

    begin
        perform public.transfer_project_ownership(v_p2, v_carol);
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N12b: admin transferred ownership'; end if;

    v_ok := false;
    begin
        perform public.change_member_role(v_p2, v_bob, 'member');
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N13b: admin changed owner role'; end if;
end $$;

-- N15-N17: archiving blocks changes; history survives
do $$
declare
    v_proj uuid := (select v::uuid from tt_state where k = 'proj');
    v_t1   uuid := (select v::uuid from tt_state where k = 't1');
    v_i1   uuid := (select v::uuid from tt_state where k = 'i1');
    v_i2   uuid := (select v::uuid from tt_state where k = 'i2');
    v_alice uuid := (select v::uuid from tt_state where k = 'u_alice');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_ok boolean := false;
    v_cnt int; v_completed boolean; v_acts int; v_audits int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_alice::text, true);

    -- archive one item (owner)
    perform public.archive_task_item(v_i2);

    -- verify as carol (task member; owner has no task_members row by design)
    perform set_config('request.jwt.claim.sub', v_carol::text, true);
    select count(*) into v_cnt from public.task_items where id = v_i2 and is_archived;
    if v_cnt <> 1 then raise exception 'FAIL: item not archived'; end if;

    -- N17: archived item is read-only
    v_ok := false;
    begin
        perform public.set_task_item_state(v_i2, true);
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N17: archived item checkbox changed'; end if;

    v_ok := false;
    begin
        perform public.update_task_item(v_i2, 'renamed');
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N17: archived item was edited'; end if;

    -- archive the task (owner)
    perform set_config('request.jwt.claim.sub', v_alice::text, true);
    perform public.archive_task(v_t1);

    -- verify as carol (task member; owner has no task_members row by design)
    perform set_config('request.jwt.claim.sub', v_carol::text, true);
    select count(*) into v_cnt from public.tasks where id = v_t1 and status = 'archived';
    if v_cnt <> 1 then raise exception 'FAIL: task not archived'; end if;

    -- N16: archived task is read-only via direct UPDATE (0 rows affected)
    perform set_config('request.jwt.claim.sub', v_carol::text, true);
    v_ok := false;
    begin
        update public.tasks set description = 'hacked' where id = v_t1;
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    select count(*) into v_cnt from public.tasks
    where id = v_t1 and description = 'checklist task';
    if v_cnt <> 1 then raise exception 'FAIL N16: archived task was modified'; end if;

    v_ok := false;
    begin
        perform public.set_task_item_state(v_i1, true);
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N16: checkbox on archived task changed'; end if;

    -- archive the project (owner)
    perform set_config('request.jwt.claim.sub', v_alice::text, true);
    perform public.archive_project(v_proj);
    select count(*) into v_cnt from public.projects where id = v_proj and status = 'archived';
    if v_cnt <> 1 then raise exception 'FAIL: project not archived'; end if;

    -- N15: archived project is read-only via direct UPDATE (0 rows affected)
    perform set_config('request.jwt.claim.sub', v_carol::text, true);
    v_ok := false;
    begin
        update public.projects set name = 'hacked' where id = v_proj;
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    select count(*) into v_cnt from public.projects where id = v_proj and name = 'Apollo';
    if v_cnt <> 1 then raise exception 'FAIL N15: archived project was modified'; end if;

    v_ok := false;
    begin
        perform public.create_task(v_proj, 'post-archive');
    exception when insufficient_privilege or raise_exception then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N15: task created in archived project'; end if;

    -- P17: history survives archiving and remains readable
    select count(*) into v_acts from public.item_actions where task_item_id = v_i1;
    if v_acts < 2 then raise exception 'FAIL P17: item_actions lost after archiving (cnt=%)', v_acts; end if;
    select count(*) into v_audits from public.audit_log where project_id = v_proj;
    if v_audits < 5 then raise exception 'FAIL P17: audit_log lost after archiving (cnt=%)', v_audits; end if;
    select is_completed into v_completed from public.task_items where id = v_i1;
    if v_completed is null then raise exception 'FAIL P17: items unreadable after archiving'; end if;
end $$;

-- N18-N20: item_actions cannot be INSERTed / UPDATEd / DELETEd by client
do $$
declare
    v_proj uuid := (select v::uuid from tt_state where k = 'proj');
    v_t1 uuid := (select v::uuid from tt_state where k = 't1');
    v_i1 uuid := (select v::uuid from tt_state where k = 'i1');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_ia bigint;
    v_ok boolean := false;
    v_cnt int;
    v_before int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_carol::text, true);

    select id into v_ia from public.item_actions where task_item_id = v_i1 limit 1;
    select count(*) into v_before from public.item_actions where task_item_id = v_i1;

    begin
        insert into public.item_actions (project_id, task_id, task_item_id, user_id, action)
        values (v_proj, v_t1, v_i1, v_carol, 'checked');
    exception when insufficient_privilege then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N18: direct INSERT into item_actions allowed'; end if;

    v_ok := false;
    begin
        update public.item_actions set action = 'unchecked' where id = v_ia;
    exception when insufficient_privilege then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N19: direct UPDATE of item_actions allowed'; end if;

    v_ok := false;
    begin
        delete from public.item_actions where id = v_ia;
    exception when insufficient_privilege then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N20: direct DELETE of item_actions allowed'; end if;

    select count(*) into v_cnt from public.item_actions where task_item_id = v_i1;
    if v_cnt <> v_before then raise exception 'FAIL: item_actions mutated (cnt=%, before=%)', v_cnt, v_before; end if;
end $$;

-- N21-N23 + N25/N26: audit_log cannot be INSERTed / UPDATEd / DELETEd;
-- client cannot spoof user_id / old_data / new_data
do $$
declare
    v_proj uuid := (select v::uuid from tt_state where k = 'proj');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_eve   uuid := (select v::uuid from tt_state where k = 'u_eve');
    v_al bigint;
    v_ok boolean := false;
    v_cnt int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_carol::text, true);

    select id into v_al from public.audit_log limit 1;

    -- spoofed insert (fake user_id + fake old_data/new_data) must be denied
    begin
        insert into public.audit_log (project_id, user_id, action, entity_type, entity_id, old_data, new_data)
        values (v_proj, v_eve, 'updated', 'project', v_proj,
                '{"title": "fake old"}'::jsonb, '{"title": "fake new"}'::jsonb);
    exception when insufficient_privilege then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N21/N25/N26: spoofed INSERT into audit_log allowed'; end if;

    v_ok := false;
    begin
        update public.audit_log set new_data = '{"is_completed": "spoofed"}'::jsonb where id = v_al;
    exception when insufficient_privilege then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N22: direct UPDATE of audit_log allowed'; end if;

    v_ok := false;
    begin
        delete from public.audit_log where id = v_al;
    exception when insufficient_privilege then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N23: direct DELETE of audit_log allowed'; end if;

    -- server-generated rows carry the true actor, never client data
    select count(*) into v_cnt from public.audit_log
    where user_id = v_eve and entity_type = 'project' and old_data is not null;
    if v_cnt <> 0 then raise exception 'FAIL N25/26: spoofed audit row exists'; end if;
end $$;

-- N24: is_completed cannot be changed by direct UPDATE (privilege revoked)
do $$
declare
    v_i1 uuid := (select v::uuid from tt_state where k = 'i1');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_ok boolean := false;
    v_completed boolean;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_carol::text, true);

    begin
        update public.task_items set is_completed = true where id = v_i1;
    exception when insufficient_privilege then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N24: direct is_completed UPDATE allowed'; end if;

    select is_completed into v_completed from public.task_items where id = v_i1;
    if v_completed is not false then raise exception 'FAIL N24: is_completed was changed'; end if;
end $$;

-- N24b/N24c: provenance columns cannot be rewritten through direct table access.
do $$
declare
    v_proj uuid := (select v::uuid from tt_state where k = 'proj');
    v_t1 uuid := (select v::uuid from tt_state where k = 't1');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_eve uuid := (select v::uuid from tt_state where k = 'u_eve');
    v_ok boolean := false;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_eve::text, true);

    begin
        update public.tasks set created_by = v_eve where id = v_t1;
    exception when insufficient_privilege then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N24b: tasks.created_by can be rewritten directly'; end if;

    v_ok := false;
    begin
        update public.projects set created_by = v_eve where id = v_proj;
    exception when insufficient_privilege then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N24c: projects.created_by can be rewritten directly'; end if;

    v_ok := false;
    begin
        update public.tasks set project_id = v_proj where id = v_t1;
    exception when insufficient_privilege then v_ok := true; end;
    if not v_ok then raise exception 'FAIL N24d: tasks.project_id can be rewritten directly'; end if;
end $$;

-- P: profile self-update only; task item edit via RPC writes 'updated'/'reordered'
do $$
declare
    v_p2    uuid := (select v::uuid from tt_state where k = 'p2');
    v_bob   uuid := (select v::uuid from tt_state where k = 'u_bob');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_t3 uuid;
    v_i3 uuid;
    v_cnt int;
    v_ok boolean;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_carol::text, true);
    update public.profiles set display_name = 'Carol Edited' where id = v_carol;

    v_ok := false;
    begin
        update public.profiles set created_at = now() - interval '1 day' where id = v_carol;
    exception when insufficient_privilege then v_ok := true; end;
    if not v_ok then raise exception 'FAIL: profiles.created_at can be rewritten directly'; end if;

    -- bob is owner of active project p2; creator becomes task member automatically
    perform set_config('request.jwt.claim.sub', v_bob::text, true);
    v_t3 := public.create_task(v_p2, 'Prepare release');
    v_i3 := public.create_task_item(v_t3, 'Changelog');
    insert into tt_state values ('i3', v_i3::text);

    perform public.update_task_item(v_i3, 'Changelog v2');
    select count(*) into v_cnt from public.audit_log
    where entity_id = v_i3 and action = 'updated'
      and old_data = '{"title": "Changelog"}'::jsonb
      and new_data = '{"title": "Changelog v2"}'::jsonb;
    if v_cnt <> 1 then raise exception 'FAIL: update_task_item audit missing (cnt=%)', v_cnt; end if;

    -- reorder via RPC produces 'reordered'
    perform public.update_task_item(p_task_item_id := v_i3, p_position := 1.5);
    select count(*) into v_cnt from public.audit_log
    where entity_id = v_i3 and action = 'reordered';
    if v_cnt <> 1 then raise exception 'FAIL: reordered audit missing'; end if;
end $$;

-- =============================================================== summary

-- Identifier-based project member RPC: resolution, authorization and audit.
do $$
declare
    v_proj uuid;
    v_alice uuid := (select v::uuid from tt_state where k = 'u_alice');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_dave uuid := (select v::uuid from tt_state where k = 'u_dave');
    v_eve uuid := (select v::uuid from tt_state where k = 'u_eve');
    v_grace uuid := gen_random_uuid();
    v_other uuid := gen_random_uuid();
    v_hank uuid := gen_random_uuid();
    v_cnt int;
begin
    insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, email_confirmed_at, created_at, updated_at, is_anonymous, is_sso_user)
    values (v_grace, 'grace@example.com', 'authenticated', 'authenticated', '{}', '{}', now(), now(), now(), false, false),
           (v_other, 'other@example.com', 'authenticated', 'authenticated', '{}', '{}', now(), now(), now(), false, false);
    insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, email_confirmed_at, created_at, updated_at, is_anonymous, is_sso_user)
    values (v_hank, 'hank@example.com', 'authenticated', 'authenticated', '{}', '{}', now(), now(), now(), false, false);
    insert into public.profiles (id, display_name) values (v_grace, 'Grace'), (v_other, 'Grace'), (v_hank, 'Hank')
    on conflict (id) do update set display_name = excluded.display_name;
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_alice::text, true);
    v_proj := public.create_project('Identifier RPC test');
    perform public.add_project_member_by_identifier(v_proj, 'grace@example.com', 'member');
    select count(*) into v_cnt from public.project_members where project_id = v_proj and user_id = v_grace;
    if v_cnt <> 1 then raise exception 'FAIL: email identifier did not add member'; end if;
    perform public.add_project_member_by_identifier(v_proj, 'other@example.com', 'member');
    perform public.add_project_member_by_identifier(v_proj, 'Hank', 'member');
    select count(*) into v_cnt from public.audit_log where project_id = v_proj and action = 'member_added' and entity_id = v_other;
    if v_cnt <> 1 then raise exception 'FAIL: identifier add did not create audit'; end if;
    begin perform public.add_project_member_by_identifier(v_proj, 'Grace', 'member'); raise exception 'FAIL: ambiguous display name was accepted'; exception when others then if sqlerrm <> 'display name is ambiguous' then raise; end if; end;
    begin perform public.add_project_member_by_identifier(v_proj, 'missing@example.com', 'member'); raise exception 'FAIL: missing user was accepted'; exception when others then if sqlerrm <> 'user not found' then raise; end if; end;
    begin perform public.add_project_member_by_identifier(v_proj, 'grace@example.com', 'member'); raise exception 'FAIL: duplicate member was accepted'; exception when others then if sqlerrm <> 'user is already a project member' then raise; end if; end;
    perform set_config('request.jwt.claim.sub', v_dave::text, true);
    begin perform public.add_project_member_by_identifier(v_proj, 'missing@example.com', 'member'); raise exception 'FAIL: viewer could call identifier RPC'; exception when others then null; end;
    perform set_config('request.jwt.claim.sub', v_eve::text, true);
    begin perform public.add_project_member_by_identifier(v_proj, 'missing@example.com', 'member'); raise exception 'FAIL: outsider could call identifier RPC'; exception when others then null; end;
end $$;

-- Project lifecycle RPCs: authorization, state transitions and immutable audit snapshots.
do $$
declare
    v_proj uuid := (select v::uuid from tt_state where k = 'p2');
    v_alice uuid := (select v::uuid from tt_state where k = 'u_alice');
    v_bob uuid := (select v::uuid from tt_state where k = 'u_bob');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_eve uuid := (select v::uuid from tt_state where k = 'u_eve');
    v_ok boolean := false;
    v_cnt int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_alice::text, true);
    perform public.update_project(v_proj, 'Orion renamed', 'Updated description');
    select count(*) into v_cnt from public.audit_log where project_id=v_proj and action='updated'
      and old_data->>'name'='Orion' and new_data->>'name'='Orion renamed';
    if v_cnt < 1 then raise exception 'FAIL: update_project audit missing'; end if;

    begin perform public.update_project(v_proj, '   ', 'x'); raise exception 'FAIL: blank project name accepted';
    exception when others then if sqlerrm <> 'project name cannot be empty' then raise; end if; end;

    perform set_config('request.jwt.claim.sub', v_bob::text, true);
    perform public.restore_project(v_proj); -- p2 is active; verify invalid state first
    raise exception 'FAIL: active project restored';
exception when raise_exception then
    if sqlerrm <> 'project is not archived' then raise; end if;
end $$;

do $$
declare
    v_proj uuid := (select v::uuid from tt_state where k = 'proj');
    v_alice uuid := (select v::uuid from tt_state where k = 'u_alice');
    v_bob uuid := (select v::uuid from tt_state where k = 'u_bob');
    v_carol uuid := (select v::uuid from tt_state where k = 'u_carol');
    v_ok boolean := false;
    v_cnt int;
begin
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_alice::text, true);
    perform public.archive_project(v_proj);
    perform public.restore_project(v_proj);
    select count(*) into v_cnt from public.projects where id=v_proj and status='active' and archived_at is null;
    if v_cnt <> 1 then raise exception 'FAIL: restore_project did not activate project'; end if;
    select count(*) into v_cnt from public.audit_log where project_id=v_proj and action='updated'
      and old_data->>'status'='archived' and new_data->>'status'='active';
    if v_cnt < 1 then raise exception 'FAIL: restore audit missing'; end if;
    perform set_config('request.jwt.claim.sub', v_carol::text, true);
    begin perform public.update_project(v_proj, 'forbidden', null); raise exception 'FAIL: member updated project'; exception when others then null; end;
end $$;

do $$
begin
    raise notice 'ALL RLS/RPC TESTS PASSED';
end $$;

select 'profiles' as tbl, count(*) from public.profiles
union all select 'projects', count(*) from public.projects
union all select 'tasks', count(*) from public.tasks
union all select 'task_members', count(*) from public.task_members
union all select 'task_assignees', count(*) from public.task_assignees
union all select 'task_items', count(*) from public.task_items
union all select 'item_actions', count(*) from public.item_actions
union all select 'audit_log', count(*) from public.audit_log;
