\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email,aud,role,raw_app_meta_data,raw_user_meta_data,email_confirmed_at,created_at,updated_at,is_anonymous,is_sso_user)
select ('95000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
  'deadline-' || n || '@test.local','authenticated','authenticated','{}','{}',now(),now(),now(),false,false
from generate_series(1,4) n;

do $$
begin
  if has_column_privilege('authenticated','public.task_items','deadline_at','UPDATE')
    or has_function_privilege('authenticated','private.process_checklist_deadlines(integer)','EXECUTE')
    or has_function_privilege('anon','public.set_task_item_deadline(uuid,timestamptz,bigint)','EXECUTE')
    or has_table_privilege('authenticated','private.checklist_deadline_state','SELECT') then
    raise exception 'deadline ACL failed';
  end if;
  if private.checklist_deadline_status(now()+interval '12 hours 1 millisecond',99,false,now()) <> 'normal'
    or private.checklist_deadline_status(now()+interval '12 hours',99,false,now()) <> 'urgent'
    or private.checklist_deadline_status(now(),99,false,now()) <> 'overdue'
    or private.checklist_deadline_status(now()-interval '1 day',100,false,now()) <> 'completed'
    or private.checklist_deadline_status(now()-interval '1 day',0,true,now()) <> 'inactive' then
    raise exception 'deadline boundaries failed';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','95000000-0000-4000-8000-000000000001',true);
select public.create_project('Deadline project','') as project \gset
select public.create_task(:'project','Deadline stage','') as task \gset
select public.create_task_item(:'task','Deadline checklist') as item \gset
select set_config('tasktrace.deadline_item', :'item', true);
select set_config('tasktrace.deadline_task', :'task', true);
select set_config('tasktrace.deadline_project', :'project', true);
select public.add_project_member(:'project','95000000-0000-4000-8000-000000000002','member');
select public.add_project_member(:'project','95000000-0000-4000-8000-000000000003','viewer');

do $$
declare v_id uuid := current_setting('tasktrace.deadline_item')::uuid; v_deadline timestamptz := now()+interval '2 days'; v_count integer;
begin
  perform public.set_task_item_deadline(v_id,v_deadline,1);
  select count(*) into v_count from public.notifications where data->>'item_id'=v_id::text;
  if v_count <> 1 then raise exception 'setter must receive its own deadline history'; end if;
  perform public.set_task_item_deadline(v_id,v_deadline,2);
  if (select count(*) from public.notifications where data->>'item_id'=v_id::text) <> v_count then raise exception 'no-op duplicated notification'; end if;
  begin
    perform public.set_task_item_deadline(v_id,now()+interval '3 days',1);
    raise exception 'stale write accepted';
  exception when sqlstate 'PT409' then null; end;
  begin
    perform public.set_task_item_deadline(v_id,now()-interval '1 second',2);
    raise exception 'past deadline accepted';
  exception when invalid_parameter_value then null; end;
  perform public.set_task_item_deadline(v_id,now()+interval '1 hour',2);
  if not exists(select 1 from public.notifications where data->>'item_id'=v_id::text and data->>'deadline_event'='urgent') then
    raise exception 'under-12h deadline did not notify immediately'; end if;
  if not exists(select 1 from public.checklist_overview where id=v_id and deadline_at=now()+interval '1 hour') then raise exception 'overview missing deadline'; end if;
end $$;

select set_config('request.jwt.claim.sub','95000000-0000-4000-8000-000000000003',true);
do $$
begin
  begin
    perform public.set_task_item_deadline(current_setting('tasktrace.deadline_item')::uuid,now()+interval '1 day',3);
    raise exception 'viewer changed deadline';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','95000000-0000-4000-8000-000000000004',true);
do $$
begin
  if exists(select 1 from public.checklist_overview where id=current_setting('tasktrace.deadline_item')::uuid) then raise exception 'outsider sees deadline'; end if;
end $$;
reset role;

-- Advance the fixture through time without an open client, then run precisely
-- the same SQL entry point that Cron invokes. Only this test database is used.
alter table public.task_items disable trigger trg_task_item_deadline_changed;
update public.task_items set deadline_at=now()-interval '1 second' where id=:'item';
alter table public.task_items enable trigger trg_task_item_deadline_changed;
update private.checklist_deadline_state set state='urgent',next_transition_at=now()-interval '1 second' where item_id=:'item';
select private.process_checklist_deadlines();
do $$
declare v_id uuid := current_setting('tasktrace.deadline_item')::uuid; v_count integer;
begin
  if (select count(*) from public.notifications where data->>'item_id'=v_id::text and data->>'deadline_event'='overdue') <> 3 then raise exception 'server job did not notify all authorized members'; end if;
  select count(*) into v_count from public.notifications where data->>'item_id'=v_id::text;
  perform private.process_checklist_deadlines();
  perform private.refresh_checklist_deadline(v_id);
  if (select count(*) from public.notifications where data->>'item_id'=v_id::text) <> v_count then raise exception 'scheduler duplicated notifications'; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','95000000-0000-4000-8000-000000000002',true);
select public.set_task_item_percentage(:'item',100,(select sync_version from public.task_items where id=:'item'));
select public.set_task_item_percentage(:'item',100,(select sync_version from public.task_items where id=:'item'));
select public.set_task_item_percentage(:'item',99,(select sync_version from public.task_items where id=:'item'));
reset role;
do $$
declare v_id uuid := current_setting('tasktrace.deadline_item')::uuid;
begin
  if (select count(*) from public.notifications where data->>'item_id'=v_id::text and data->>'deadline_event'='completed') <> 3
    or (select count(*) from public.notifications where data->>'item_id'=v_id::text and data->>'deadline_event'='reopened_overdue') <> 3 then
    raise exception 'completion/reopening notifications missing or duplicated'; end if;
  if (select state from private.checklist_deadline_state where item_id=v_id) <> 'overdue' then raise exception 'reopening failed'; end if;
  if (select status from public.tasks where id=current_setting('tasktrace.deadline_task')::uuid) <> 'in_progress' then raise exception 'derived stage status stuck'; end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','95000000-0000-4000-8000-000000000001',true);
select public.archive_task(:'task');
select public.restore_task(:'task');
select public.set_task_item_deadline(:'item',now()+interval '2 days',(select sync_version from public.task_items where id=:'item'));
reset role;
do $$
begin
  if (select state from private.checklist_deadline_state where item_id=current_setting('tasktrace.deadline_item')::uuid) <> 'normal' then raise exception 'moved deadline retained old warning'; end if;
end $$;
set local role authenticated;
select public.set_task_item_deadline(:'item',null,(select sync_version from public.task_items where id=:'item'));
reset role;
do $$
declare v_id uuid := current_setting('tasktrace.deadline_item')::uuid;
begin
  if (select next_transition_at from private.checklist_deadline_state where item_id=v_id) is not null then raise exception 'removed deadline remains scheduled'; end if;
  if not exists(select 1 from public.notifications where data->>'item_id'=v_id::text and data->>'deadline_event'='overdue') then raise exception 'history removed with deadline'; end if;
  if exists(select 1 from private.task_item_sync_changes where task_item_id=v_id and item is not null and not (item ? 'deadline_at')) then raise exception 'pull omitted deadline'; end if;
end $$;
rollback;
