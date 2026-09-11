-- Independent Notifications integration tests for a real local Supabase schema.
-- Prerequisite: npx supabase db reset
-- Run with psql as the local postgres test administrator. Security assertions
-- explicitly switch to `authenticated` and set the JWT subject claim.
\set ON_ERROR_STOP on

begin;

create temp table ntf_state (key text primary key, id uuid not null);
grant select, insert, update on ntf_state to authenticated;

insert into auth.users (id, email, aud, role, raw_user_meta_data, created_at, updated_at, email_confirmed_at, is_sso_user, is_anonymous) values
  ('10000000-0000-0000-0000-000000000001', 'ntf-owner-a@test.local', 'authenticated', 'authenticated', '{"display_name":"Notification Owner A"}', now(), now(), now(), false, false),
  ('10000000-0000-0000-0000-000000000002', 'ntf-admin-b@test.local', 'authenticated', 'authenticated', '{"display_name":"Notification Admin B"}', now(), now(), now(), false, false),
  ('10000000-0000-0000-0000-000000000003', 'ntf-outsider-c@test.local', 'authenticated', 'authenticated', '{"display_name":"Notification Outsider C"}', now(), now(), now(), false, false);
insert into ntf_state values ('user_a','10000000-0000-0000-0000-000000000001'), ('user_b','10000000-0000-0000-0000-000000000002'), ('user_c','10000000-0000-0000-0000-000000000003');

set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from ntf_state where key='user_a'), true);
insert into ntf_state select 'project', public.create_project('Notifications verification', 'SQL integration test');
select public.add_project_member((select id from ntf_state where key='project'), (select id from ntf_state where key='user_b'), 'admin');
insert into ntf_state select 'task_main', public.create_task((select id from ntf_state where key='project'), 'Main notification task', 'Recipient B');
insert into ntf_state select 'item_main', public.create_task_item((select id from ntf_state where key='task_main'), 'Initial checklist text');
select public.approve_task_member((select id from ntf_state where key='task_main'), (select id from ntf_state where key='user_b'));
reset role;

select count(*) as changed_before
  from public.notifications
 where user_id=(select id from ntf_state where key='user_b')
   and task_id=(select id from ntf_state where key='task_main')
   and type='task_item_changed' \gset
set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from ntf_state where key='user_b'), true);
insert into ntf_state select 'task_for_a', public.create_task((select id from ntf_state where key='project'), 'Notification for A', 'Recipient A');
select public.approve_task_member((select id from ntf_state where key='task_for_a'), (select id from ntf_state where key='user_a'));
reset role;

insert into ntf_state select 'notification_a', id from public.notifications where user_id=(select id from ntf_state where key='user_a') and type='task_member_added' order by created_at desc limit 1;
insert into ntf_state select 'notification_b', id from public.notifications where user_id=(select id from ntf_state where key='user_b') and type='task_member_added' order by created_at desc limit 1;

set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from ntf_state where key='user_a'), true);
do $$ begin
  if (select count(*) from public.notifications where id=(select id from ntf_state where key='notification_a')) <> 1 then raise exception 'FAIL NTF01: A cannot see own notification'; end if;
  raise notice 'PASS NTF01: A sees own notification';
  if (select count(*) from public.notifications where id=(select id from ntf_state where key='notification_b')) <> 0 then raise exception 'FAIL NTF02: A can see B notification'; end if;
  raise notice 'PASS NTF02: foreign notification hidden by RLS';
end $$;
do $$ declare denied boolean:=false; begin
  begin insert into public.notifications(user_id,type,title,body,dedupe_key) values ((select id from ntf_state where key='user_a'),'task_assigned','spoof','spoof','client-spoof'); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL NTF03: authenticated direct INSERT allowed'; end if; raise notice 'PASS NTF03: authenticated direct INSERT denied';
end $$;
do $$ declare denied boolean:=false; begin
  begin
    perform private.create_notification((select id from ntf_state where key='user_a'), null, null, 'task_assigned', 'spoof', 'spoof', '{}', 'client-helper-spoof');
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL NTF03b: authenticated notification helper callable'; end if;
  raise notice 'PASS NTF03b: notification helper is server-only';
end $$;
select public.mark_notification_read((select id from ntf_state where key='notification_a'));
do $$ begin
  if not exists (select 1 from public.notifications where id=(select id from ntf_state where key='notification_a') and is_read and read_at is not null) then raise exception 'FAIL NTF04: own mark-as-read failed'; end if; raise notice 'PASS NTF04: own mark-as-read works';
end $$;
select public.mark_notification_read((select id from ntf_state where key='notification_b'));
do $$ declare denied boolean:=false; begin
  begin update public.notifications set title='spoof' where id=(select id from ntf_state where key='notification_b'); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL NTF05: authenticated UPDATE allowed'; end if; raise notice 'PASS NTF05: foreign UPDATE denied';
end $$;
do $$ declare denied boolean:=false; begin
  begin delete from public.notifications where id=(select id from ntf_state where key='notification_a'); exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL NTF06: authenticated DELETE allowed'; end if; raise notice 'PASS NTF06: authenticated DELETE denied';
end $$;
reset role;
do $$ begin
  if (select is_read from public.notifications where id=(select id from ntf_state where key='notification_b')) then raise exception 'FAIL NTF05b: foreign mark-as-read changed row'; end if; raise notice 'PASS NTF05b: foreign mark-as-read has no effect';
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from ntf_state where key='user_a'), true);
select public.add_task_assignee((select id from ntf_state where key='task_main'), (select id from ntf_state where key='user_b'));
select public.remove_task_assignee((select id from ntf_state where key='task_main'), (select id from ntf_state where key='user_b'));
select public.set_task_item_state((select id from ntf_state where key='item_main'), true);
select public.set_task_item_state((select id from ntf_state where key='item_main'), false);
select public.set_task_item_comment((select id from ntf_state where key='item_main'), 'Progress context note');
select public.set_task_item_percentage((select id from ntf_state where key='item_main'), 25);
select public.update_task_item((select id from ntf_state where key='item_main'), 'Changed checklist text');
select public.revoke_task_member((select id from ntf_state where key='task_main'), (select id from ntf_state where key='user_b'));
reset role;

select count(*) = (:changed_before::bigint + 3) as item_changed_count_ok
  from public.notifications
 where user_id=(select id from ntf_state where key='user_b')
   and task_id=(select id from ntf_state where key='task_main')
   and type='task_item_changed' \gset
\if :item_changed_count_ok
\else
\echo 'FAIL NTF12a: duplicate/missing item changed notifications'
\quit 1
\endif

do $$ begin
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_b') and task_id=(select id from ntf_state where key='task_main') and type='task_member_added') then raise exception 'FAIL NTF07'; end if; raise notice 'PASS NTF07: approve_task_member generated task_member_added';
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_b') and task_id=(select id from ntf_state where key='task_main') and type='task_member_removed') then raise exception 'FAIL NTF08'; end if; raise notice 'PASS NTF08: revoke_task_member generated task_member_removed';
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_b') and task_id=(select id from ntf_state where key='task_main') and type='task_assigned') then raise exception 'FAIL NTF09'; end if; raise notice 'PASS NTF09: add_task_assignee generated task_assigned';
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_b') and task_id=(select id from ntf_state where key='task_main') and type='task_unassigned') then raise exception 'FAIL NTF10'; end if; raise notice 'PASS NTF10: remove_task_assignee generated task_unassigned';
  if (select count(*) from public.notifications where user_id=(select id from ntf_state where key='user_b') and task_id=(select id from ntf_state where key='task_main') and type in ('task_item_checked','task_item_unchecked')) <> 2 then raise exception 'FAIL NTF11'; end if; raise notice 'PASS NTF11: checked and unchecked notifications generated';
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_b') and task_id=(select id from ntf_state where key='task_main') and type='task_item_changed') then raise exception 'FAIL NTF12'; end if; raise notice 'PASS NTF12: update_task_item generated task_item_changed';
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_b') and task_id=(select id from ntf_state where key='task_main') and type='task_item_changed' and body like '%комментарий%') then raise exception 'FAIL NTF12d: comment notification missing'; end if;
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_b') and task_id=(select id from ntf_state where key='task_main') and type='task_item_changed' and body like '%прогресс 25%') then raise exception 'FAIL NTF12e: percentage notification missing'; end if;
  if not exists (select 1 from public.audit_log where entity_type='task_item' and entity_id=(select id from ntf_state where key='item_main') and new_data @> '{"comment":"Progress context note"}'::jsonb) then raise exception 'FAIL NTF12f: comment audit missing'; end if;
  if not exists (select 1 from public.audit_log where entity_type='task_item' and entity_id=(select id from ntf_state where key='item_main') and new_data->>'percentage'='25') then raise exception 'FAIL NTF12g: percentage audit missing'; end if;
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_b') and task_id=(select id from ntf_state where key='task_main') and type='task_item_checked' and title='Пункт отмечен' and body like '%Initial checklist text%Main notification task%Notifications verification%') then raise exception 'FAIL NTF12b: contextual checked notification text'; end if;
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_b') and task_id=(select id from ntf_state where key='task_main') and type='task_item_changed' and body like '%Changed checklist text%Main notification task%Notifications verification%') then raise exception 'FAIL NTF12c: contextual changed notification text'; end if;
  raise notice 'PASS NTF12b-c: notification text includes item, task and project';
end $$;
do $$ begin
  if exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_a') and task_id=(select id from ntf_state where key='task_main')) then raise exception 'FAIL NTF13'; end if; raise notice 'PASS NTF13: actor receives no self-notification';
  if exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_c')) then raise exception 'FAIL NTF14'; end if; raise notice 'PASS NTF14: unauthorized outsider receives no notification';
end $$;

create temp table ntf_counts (key text primary key, value bigint not null);
insert into ntf_counts select 'before', count(*) from public.notifications;
savepoint notification_business_rollback;
set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from ntf_state where key='user_a'), true);
select public.approve_task_member((select id from ntf_state where key='task_main'), (select id from ntf_state where key='user_b'));
reset role;
rollback to savepoint notification_business_rollback;
do $$ begin
  if (select count(*) from public.notifications) <> (select value from ntf_counts where key='before') then raise exception 'FAIL NTF15: rollback left notification'; end if;
  if exists (select 1 from public.task_members where task_id=(select id from ntf_state where key='task_main') and user_id=(select id from ntf_state where key='user_b')) then raise exception 'FAIL NTF15: rollback left task access'; end if;
  raise notice 'PASS NTF15: rollback leaves no notification or membership';
end $$;

select private.create_notification((select id from ntf_state where key='user_b'),(select id from ntf_state where key='project'),(select id from ntf_state where key='task_main'),'task_assigned','Dedupe','Dedupe','{}','notifications-test:dedupe');
select private.create_notification((select id from ntf_state where key='user_b'),(select id from ntf_state where key='project'),(select id from ntf_state where key='task_main'),'task_assigned','Dedupe retry','Dedupe retry','{}','notifications-test:dedupe');
do $$ begin
  if (select count(*) from public.notifications where user_id=(select id from ntf_state where key='user_b') and dedupe_key='notifications-test:dedupe') <> 1 then raise exception 'FAIL NTF16'; end if; raise notice 'PASS NTF16: duplicate delivery is suppressed';
end $$;

-- Archive/restore notifications follow the same audit transaction as the
-- project/task state transition.  The actor is excluded and an outsider is
-- never addressed.
set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from ntf_state where key='user_a'), true);
select public.archive_project((select id from ntf_state where key='project'));
select public.restore_project((select id from ntf_state where key='project'));
reset role;
do $$ begin
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_b') and project_id=(select id from ntf_state where key='project') and type='project_archived') then raise exception 'FAIL NTF16b: project archive notification missing'; end if;
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_b') and task_id=(select id from ntf_state where key='task_for_a') and type='task_archived') then raise exception 'FAIL NTF16c: task archive notification missing'; end if;
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_b') and project_id=(select id from ntf_state where key='project') and type='project_restored') then raise exception 'FAIL NTF16d: project restore notification missing'; end if;
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_b') and task_id=(select id from ntf_state where key='task_for_a') and type='task_restored') then raise exception 'FAIL NTF16e: task restore notification missing'; end if;
  if exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_a') and type in ('project_archived','project_restored','task_archived','task_restored')) then raise exception 'FAIL NTF16f: archive actor received self-notification'; end if;
  if exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_c') and type in ('project_archived','project_restored','task_archived','task_restored')) then raise exception 'FAIL NTF16g: outsider received archive notification'; end if;
  raise notice 'PASS NTF16b-g: archive/restore notifications are scoped and atomic';
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from ntf_state where key='user_a'), true);
select public.approve_task_member((select id from ntf_state where key='task_main'), (select id from ntf_state where key='user_b'));
select public.revoke_task_member((select id from ntf_state where key='task_main'), (select id from ntf_state where key='user_b'));
reset role;
do $$ begin
  if (select count(*) from public.notifications where user_id=(select id from ntf_state where key='user_b') and task_id=(select id from ntf_state where key='task_main') and type='task_member_added') <> 2 then raise exception 'FAIL NTF17: distinct approvals collapsed'; end if;
  if (select count(distinct dedupe_key) from public.notifications where user_id=(select id from ntf_state where key='user_b') and task_id=(select id from ntf_state where key='task_main') and type='task_member_added') <> 2 then raise exception 'FAIL NTF17: audit keys not distinct'; end if;
  raise notice 'PASS NTF17: distinct audit events remain distinct';
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from ntf_state where key='user_b'), true);
do $$ begin
  if not exists (select 1 from public.notifications where task_id=(select id from ntf_state where key='task_main') and type='task_member_removed') then raise exception 'FAIL NTF18: revoke notification not retained'; end if;
  if exists (select 1 from public.tasks where id=(select id from ntf_state where key='task_main')) then raise exception 'FAIL NTF18: revoked task still visible'; end if;
  raise notice 'PASS NTF18: revoke notification retained and task access remains denied';
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from ntf_state where key='user_a'), true);
select public.remove_project_member((select id from ntf_state where key='project'), (select id from ntf_state where key='user_b'));
reset role;
do $$ begin
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='user_b') and task_id=(select id from ntf_state where key='task_for_a') and type='task_member_removed') then raise exception 'FAIL NTF19: project removal notification missing'; end if;
  if not exists (select 1 from public.audit_log where entity_type='task_member' and entity_id=(select id from ntf_state where key='user_b') and new_data->>'task_id'=(select id::text from ntf_state where key='task_for_a') and action='access_revoked') then raise exception 'FAIL NTF19: per-task access audit missing'; end if;
  raise notice 'PASS NTF19: project removal preserves task audit and notification';
end $$;

do $$ begin raise notice 'ALL NOTIFICATION TESTS PASSED'; end $$;

rollback;
