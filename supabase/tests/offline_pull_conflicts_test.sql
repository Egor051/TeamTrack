\set ON_ERROR_STOP on
begin;

insert into auth.users (id,email,aud,role,raw_app_meta_data,raw_user_meta_data,
  email_confirmed_at,created_at,updated_at,is_anonymous,is_sso_user)
values
 ('92000000-0000-4000-8000-000000000001','phase5-owner@test.local','authenticated','authenticated','{}','{}',now(),now(),now(),false,false),
 ('92000000-0000-4000-8000-000000000002','phase5-member@test.local','authenticated','authenticated','{}','{}',now(),now(),now(),false,false);

do $$
begin
  if has_table_privilege('anon','private.task_item_sync_changes','SELECT')
     or has_table_privilege('authenticated','private.task_item_sync_changes','SELECT')
     or has_function_privilege('anon','public.pull_task_item_changes(bigint,integer)','EXECUTE')
     or has_column_privilege('authenticated','public.task_items','sync_version','UPDATE')
     or not has_function_privilege('authenticated','public.pull_task_item_changes(bigint,integer)','EXECUTE') then
    raise exception 'phase 5 ACL failed';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','92000000-0000-4000-8000-000000000001',true);
select public.create_project('Phase 5 sync','test') \gset
\set project :create_project
select public.create_task(:'project','Phase 5 task','active') \gset
\set task :create_task
select public.create_task_item(:'task','Phase 5 item') \gset
\set item :create_task_item
select set_config('tasktrace.test_item', :'item', true);
select public.add_project_member(:'project','92000000-0000-4000-8000-000000000002','member');

do $$
declare
  v_item uuid := current_setting('tasktrace.test_item')::uuid;
  v_result jsonb;
  v_audit integer;
  v_version bigint;
  v_cursor bigint;
  v_page jsonb;
  v_seen integer := 0;
begin
  if (select sync_version from public.task_items where id=v_item) <> 1 then
    raise exception 'initial sync version missing';
  end if;
  perform public.set_task_item_comment(v_item, 'online');
  if (select sync_version from public.task_items where id=v_item) <> 2 then
    raise exception 'online comment did not advance version';
  end if;
  perform public.update_task_item(v_item, 'Renamed item');
  if (select sync_version from public.task_items where id=v_item) <> 2 then
    raise exception 'title caused false version bump';
  end if;
  select count(*) into v_audit from public.audit_log where entity_id=v_item;
  v_result := public.apply_task_item_percentage_operation_v2(
    '92000000-0000-4000-8000-000000000011', v_item, 1, 70);
  if v_result->>'status' <> 'conflict' or (v_result->>'version')::bigint <> 2
     or (select percentage from public.task_items where id=v_item) <> 0
     or (select count(*) from public.audit_log where entity_id=v_item) <> v_audit then
    raise exception 'conflict had side effects or consumed receipt';
  end if;
  v_result := public.apply_task_item_percentage_operation_v2(
    '92000000-0000-4000-8000-000000000011', v_item, 2, 70);
  if v_result->>'status' <> 'applied' or (v_result->>'version')::bigint <> 3
     or (select percentage from public.task_items where id=v_item) <> 70 then
    raise exception 'retry after conflict failed';
  end if;
  v_audit := (select count(*) from public.audit_log where entity_id=v_item);
  if public.apply_task_item_percentage_operation_v2(
      '92000000-0000-4000-8000-000000000011', v_item, 1, 70) <> v_result
     or (select count(*) from public.audit_log where entity_id=v_item) <> v_audit then
    raise exception 'completed duplicate did not win over stale version';
  end if;
  perform public.set_task_item_percentage(v_item, 100);
  if (select sync_version from public.task_items where id=v_item) <> 4 then
    raise exception 'online progress did not advance version';
  end if;
  v_result := public.apply_task_item_state_operation_v2(
    '92000000-0000-4000-8000-000000000012', v_item, 4, true);
  if v_result->>'status' <> 'applied' or (v_result->>'version')::bigint <> 5
     or (select sync_version from public.task_items where id=v_item) <> 5 then
    raise exception 'accepted no-op did not advance version';
  end if;
  v_result := public.apply_task_item_comment_operation_v2(
    '92000000-0000-4000-8000-000000000013', v_item, 5, 'offline');
  if v_result->>'status' <> 'applied' or (v_result->>'version')::bigint <> 6 then
    raise exception 'operation chain version failed';
  end if;
  v_cursor := 0;
  loop
    v_page := public.pull_task_item_changes(v_cursor, 2);
    if (v_page->>'next_cursor')::bigint < v_cursor then raise exception 'pull cursor regressed'; end if;
    v_cursor := (v_page->>'next_cursor')::bigint;
    v_seen := v_seen + jsonb_array_length(v_page->'changes');
    exit when not (v_page->>'has_more')::boolean;
  end loop;
  if v_seen < 6 then raise exception 'pull missed item changes: %', v_seen; end if;
  if public.get_task_item_sync_cursor() < v_cursor then raise exception 'starting cursor regressed'; end if;
end $$;

select set_config('request.jwt.claim.sub','92000000-0000-4000-8000-000000000002',true);
do $$
declare v_item uuid := current_setting('tasktrace.test_item')::uuid;
begin
  if not exists (select 1 from jsonb_array_elements(public.pull_task_item_changes(0,500)->'changes') c
    where c->>'task_item_id'=v_item::text) then raise exception 'member cannot pull item'; end if;
end $$;
select set_config('request.jwt.claim.sub','92000000-0000-4000-8000-000000000001',true);
select public.archive_task_item(:'item');
select public.hard_delete_task_item(:'item');
do $$
declare v_item uuid := current_setting('tasktrace.test_item')::uuid;
begin
  if not exists (select 1 from jsonb_array_elements(public.pull_task_item_changes(0,500)->'changes') c
    where c->>'task_item_id'=v_item::text and c->>'change_type'='delete' and c->'item'='null'::jsonb) then
    raise exception 'hard delete tombstone missing';
  end if;
end $$;
reset role;
delete from public.project_members where project_id=:'project' and user_id='92000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub','92000000-0000-4000-8000-000000000002',true);
do $$
declare v_item uuid := current_setting('tasktrace.test_item')::uuid;
begin
  if exists (select 1 from jsonb_array_elements(public.pull_task_item_changes(0,500)->'changes') c
    where c->>'task_item_id'=v_item::text) then raise exception 'revoked member can pull item'; end if;
end $$;
reset role;
rollback;
