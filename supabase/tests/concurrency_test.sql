-- Reproducible two-session checkbox concurrency harness.
-- A single SQL file cannot create two independent backend sessions. Run the
-- setup block once, then execute SESSION A and SESSION B concurrently in two
-- psql terminals. SESSION B blocks on the row lock held by SESSION A; after A
-- commits, B completes and the final assertions prove serialized transitions.
--
-- Setup (local postgres):
--   \i supabase/tests/concurrency_test.sql
-- Then copy each SESSION block into separate psql sessions.
\set ON_ERROR_STOP on

-- SETUP: run once as postgres, then keep the generated UUIDs.
begin;
create temp table if not exists cc_state (key text primary key, id uuid not null);
grant select, insert, update on cc_state to authenticated;
insert into auth.users (id,email,aud,role,raw_user_meta_data,email_confirmed_at,created_at,updated_at,is_anonymous,is_sso_user)
values ('30000000-0000-0000-0000-000000000001','cc-owner@test.local','authenticated','authenticated','{}',now(),now(),now(),false,false)
on conflict (id) do nothing;
set local role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',true);
insert into cc_state select 'project',public.create_project('Concurrency project');
insert into cc_state select 'task',public.create_task((select id from cc_state where key='project'),'Concurrency task');
insert into cc_state select 'item',public.create_task_item((select id from cc_state where key='task'),'Concurrent item');
reset role;
commit;
select * from cc_state;

-- SESSION A (replace :item with the UUID printed above)
-- begin;
-- select project_id, task_id from public.task_items where id = :'item' \gset
-- -- Hold locks in the same canonical order as the production RPC:
-- -- project -> task -> item. These statements run as postgres before the
-- -- session switches to authenticated for the actual RPC call.
-- select id from public.projects where id = :'project_id' for update;
-- select id from public.tasks where id = :'task_id' for update;
-- select id from public.task_items where id = :'item' for update;
-- select pg_sleep(5);
-- set local role authenticated;
-- select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',true);
-- select public.set_task_item_state(:'item', true);
-- commit;

-- SESSION B (start while SESSION A is sleeping; it waits for A's lock)
-- begin;
-- set local role authenticated;
-- select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',true);
-- select public.set_task_item_state(:'item', false);
-- commit;

-- FINAL ASSERTIONS (run after both sessions commit)
-- select is_completed from public.task_items where id = :'item';
-- select action,created_at from public.item_actions where task_item_id=:'item' order by created_at;
-- select action,old_data,new_data from public.audit_log where entity_id=:'item' order by created_at;
-- select count(*) as transition_notifications
-- from public.notifications
-- where task_id = :'task_id'
--   and type in ('task_item_checked', 'task_item_unchecked');
-- Expected: final state false, exactly checked then unchecked actions/audits,
-- and exactly one notification per transition (no duplicates).
