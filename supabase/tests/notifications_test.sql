-- Notifications integration tests for the canonical project/checklist model.
\set ON_ERROR_STOP on
begin;

create temp table ntf_state (key text primary key, id uuid not null);
grant select, insert, update on ntf_state to authenticated;

insert into auth.users (id, email, aud, role, raw_user_meta_data, created_at, updated_at, email_confirmed_at, is_sso_user, is_anonymous) values
  ('10000000-0000-0000-0000-000000000001', 'ntf-owner@test.local', 'authenticated', 'authenticated', '{"display_name":"Notification Owner"}', now(), now(), now(), false, false),
  ('10000000-0000-0000-0000-000000000002', 'ntf-admin@test.local', 'authenticated', 'authenticated', '{"display_name":"Notification Admin"}', now(), now(), now(), false, false),
  ('10000000-0000-0000-0000-000000000003', 'ntf-outsider@test.local', 'authenticated', 'authenticated', '{"display_name":"Notification Outsider"}', now(), now(), now(), false, false);
insert into ntf_state values
  ('owner','10000000-0000-0000-0000-000000000001'),
  ('admin','10000000-0000-0000-0000-000000000002'),
  ('outsider','10000000-0000-0000-0000-000000000003');

set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from ntf_state where key='owner'), true);
insert into ntf_state select 'project', public.create_project('Notifications verification', 'SQL integration test');
select public.add_project_member((select id from ntf_state where key='project'), (select id from ntf_state where key='admin'), 'admin');
insert into ntf_state select 'task', public.create_task((select id from ntf_state where key='project'), 'Notification stage', 'Recipient admin');
insert into ntf_state select 'item', public.create_task_item((select id from ntf_state where key='task'), 'Initial checklist text');
select public.set_task_member_override((select id from ntf_state where key='task'), (select id from ntf_state where key='admin'), 'viewer');
reset role;

insert into ntf_state
select 'override_notification', id
  from public.notifications
 where user_id=(select id from ntf_state where key='admin')
   and type='task_role_changed'
 order by created_at desc limit 1;

set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from ntf_state where key='admin'), true);
do $$ begin
  if (select count(*) from public.notifications where id=(select id from ntf_state where key='override_notification')) <> 1 then
    raise exception 'FAIL NTF01: recipient cannot see own role notification';
  end if;
  if not exists (
    select 1 from public.notifications
     where id=(select id from ntf_state where key='override_notification')
       and body like '%Только просмотр%'
       and body like '%чек-листа%'
  ) then raise exception 'FAIL NTF02: override notification is misleading'; end if;
end $$;
do $$ declare denied boolean:=false; begin
  begin
    insert into public.notifications(user_id,type,title,body,dedupe_key)
    values ((select id from ntf_state where key='admin'),'task_assigned','spoof','spoof','client-spoof');
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL NTF03: authenticated direct INSERT allowed'; end if;
end $$;
do $$ declare denied boolean:=false; begin
  begin
    perform private.create_notification((select id from ntf_state where key='admin'), null, null, 'task_assigned', 'spoof', 'spoof', '{}', 'client-helper-spoof');
  exception when insufficient_privilege then denied:=true; end;
  if not denied then raise exception 'FAIL NTF04: private notification helper callable'; end if;
end $$;
select public.mark_notification_read((select id from ntf_state where key='override_notification'));
do $$ begin
  if not exists (select 1 from public.notifications where id=(select id from ntf_state where key='override_notification') and is_read and read_at is not null) then
    raise exception 'FAIL NTF05: own mark-as-read failed';
  end if;
end $$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from ntf_state where key='owner'), true);
select public.add_task_assignee((select id from ntf_state where key='task'), (select id from ntf_state where key='admin'));
select public.remove_task_assignee((select id from ntf_state where key='task'), (select id from ntf_state where key='admin'));
select public.set_task_item_state((select id from ntf_state where key='item'), true);
select public.set_task_item_state((select id from ntf_state where key='item'), false);
select public.set_task_item_comment((select id from ntf_state where key='item'), 'Progress context note');
select public.set_task_item_percentage((select id from ntf_state where key='item'), 25);
select public.update_task_item((select id from ntf_state where key='item'), 'Changed checklist text');
select public.clear_task_member_override((select id from ntf_state where key='task'), (select id from ntf_state where key='admin'));
reset role;

do $$ begin
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='admin') and type='task_assigned') then raise exception 'FAIL NTF06'; end if;
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='admin') and type='task_unassigned') then raise exception 'FAIL NTF07'; end if;
  if (select count(*) from public.notifications where user_id=(select id from ntf_state where key='admin') and type in ('task_item_checked','task_item_unchecked')) <> 2 then raise exception 'FAIL NTF08'; end if;
  if (select count(*) from public.notifications where user_id=(select id from ntf_state where key='admin') and type='task_item_changed') <> 3 then raise exception 'FAIL NTF09: item notification count'; end if;
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='admin') and type='task_item_changed' and body like '%комментарий%') then raise exception 'FAIL NTF10'; end if;
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='admin') and type='task_item_changed' and body like '%прогресс 25%') then raise exception 'FAIL NTF11'; end if;
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='admin') and type='task_role_changed' and body like '%снова наследуются%') then raise exception 'FAIL NTF12'; end if;
  if exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='owner') and task_id=(select id from ntf_state where key='task')) then raise exception 'FAIL NTF13: actor received self-notification'; end if;
  if exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='outsider')) then raise exception 'FAIL NTF14: outsider received notification'; end if;
end $$;

create temp table ntf_counts (key text primary key, value bigint not null);
insert into ntf_counts select 'before', count(*) from public.notifications;
savepoint notification_business_rollback;
set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from ntf_state where key='owner'), true);
select public.set_task_member_override((select id from ntf_state where key='task'), (select id from ntf_state where key='admin'), 'member');
reset role;
rollback to savepoint notification_business_rollback;
do $$ begin
  if (select count(*) from public.notifications) <> (select value from ntf_counts where key='before') then raise exception 'FAIL NTF15: rollback left notification'; end if;
  if not exists (select 1 from public.task_members where task_id=(select id from ntf_state where key='task') and user_id=(select id from ntf_state where key='admin') and role_override is null) then raise exception 'FAIL NTF15: rollback did not restore inherited role state'; end if;
end $$;

select private.create_notification((select id from ntf_state where key='admin'),(select id from ntf_state where key='project'),(select id from ntf_state where key='task'),'task_assigned','Dedupe','Dedupe','{}','notifications-test:dedupe');
select private.create_notification((select id from ntf_state where key='admin'),(select id from ntf_state where key='project'),(select id from ntf_state where key='task'),'task_assigned','Dedupe retry','Dedupe retry','{}','notifications-test:dedupe');
do $$ begin
  if (select count(*) from public.notifications where user_id=(select id from ntf_state where key='admin') and dedupe_key='notifications-test:dedupe') <> 1 then raise exception 'FAIL NTF16: dedupe'; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from ntf_state where key='owner'), true);
select public.archive_project((select id from ntf_state where key='project'));
select public.restore_project((select id from ntf_state where key='project'));
reset role;
do $$ begin
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='admin') and type='project_archived') then raise exception 'FAIL NTF17'; end if;
  if not exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='admin') and type='project_restored') then raise exception 'FAIL NTF18'; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', (select id::text from ntf_state where key='owner'), true);
select public.set_task_member_override((select id from ntf_state where key='task'), (select id from ntf_state where key='admin'), 'viewer');
select public.remove_project_member((select id from ntf_state where key='project'), (select id from ntf_state where key='admin'));
reset role;
do $$ begin
  if exists (select 1 from public.project_members where project_id=(select id from ntf_state where key='project') and user_id=(select id from ntf_state where key='admin')) then raise exception 'FAIL NTF19: membership remains'; end if;
  if exists (select 1 from public.task_members where task_id=(select id from ntf_state where key='task') and user_id=(select id from ntf_state where key='admin')) then raise exception 'FAIL NTF19: override remains'; end if;
  if exists (select 1 from public.audit_log where entity_type='task_member' and entity_id=(select id from ntf_state where key='admin') and action='access_revoked') then raise exception 'FAIL NTF20: misleading access revocation audit remains'; end if;
  if exists (select 1 from public.notifications where user_id=(select id from ntf_state where key='admin') and type='task_member_removed') then raise exception 'FAIL NTF20: misleading task revocation notification remains'; end if;
end $$;

do $$ begin
  if exists (
    select 1 from public.notifications
     where task_id is not null
       and (title like '%задач%' or body like '%доступ к задаче%' or body like '%в задаче «%' or body like 'Задача «%')
  ) then raise exception 'FAIL NTF21: legacy task terminology'; end if;
  raise notice 'ALL NOTIFICATION TESTS PASSED';
end $$;

rollback;
