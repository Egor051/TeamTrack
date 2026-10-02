\set ON_ERROR_STOP on
begin;

insert into auth.users (id,email,aud,role,raw_app_meta_data,raw_user_meta_data,email_confirmed_at,created_at,updated_at,is_anonymous,is_sso_user)
values
 ('94000000-0000-4000-8000-000000000001','bootstrap-owner@test.local','authenticated','authenticated','{}','{"display_name":"Bootstrap owner"}',now(),now(),now(),false,false),
 ('94000000-0000-4000-8000-000000000002','bootstrap-viewer@test.local','authenticated','authenticated','{}','{"display_name":"Bootstrap viewer"}',now(),now(),now(),false,false),
 ('94000000-0000-4000-8000-000000000003','bootstrap-foreign@test.local','authenticated','authenticated','{}','{"display_name":"Foreign user"}',now(),now(),now(),false,false);

set local role authenticated;
select set_config('request.jwt.claim.sub','94000000-0000-4000-8000-000000000001',true);
select public.create_project('Bootstrap active','') as active_project \gset
select public.create_task(:'active_project','Bootstrap stage','') as task \gset
select public.create_task_item(:'task','Bootstrap item') as item \gset
select public.create_task_item(:'task','Archived item') as archived_item \gset
select public.set_task_item_percentage(:'item',40);
select public.set_task_item_comment(:'item','Current comment');
select public.archive_task_item(:'archived_item');
select public.add_project_member(:'active_project','94000000-0000-4000-8000-000000000002','viewer');
select public.set_task_member_override(:'task','94000000-0000-4000-8000-000000000002','member');
select public.add_task_assignee(:'task','94000000-0000-4000-8000-000000000002');
select public.create_project('Bootstrap archive','') as archive_project \gset
select public.create_task(:'archive_project','Archived stage','') as archived_task \gset
select public.archive_task(:'archived_task');
select public.archive_project(:'archive_project');
select public.create_task_template('Bootstrap template','') as template \gset
select public.create_task_template_item(:'template','Template content') as template_item \gset
select set_config('request.jwt.claim.sub','94000000-0000-4000-8000-000000000003',true);
select public.create_project('Foreign project','') as foreign_project \gset
select public.create_task(:'foreign_project','Foreign stage','') as foreign_task \gset
select public.create_task_item(:'foreign_task','Foreign item');

reset role;
insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data,new_data,created_at)
values (:'active_project','94000000-0000-4000-8000-000000000001','updated','task_item',:'item','{"percentage":0}','{"percentage":10}',now()-interval '91 days');
insert into public.notifications(user_id,type,title,body,is_read,read_at,created_at,dedupe_key)
select '94000000-0000-4000-8000-000000000001','task_item_changed','Notice','Body',g > 205,
  case when g > 205 then now() else null end,now() - g * interval '1 second','bootstrap-' || g
from generate_series(1,325) g;

do $$ begin
  if has_function_privilege('anon','public.get_offline_account_manifest(text)','EXECUTE')
    or has_function_privilege('anon','public.get_offline_account_page(text,text,integer,integer)','EXECUTE')
    or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname in ('public','private') and p.proname in ('get_offline_account_manifest','get_offline_account_page','offline_account_rows') and p.prosecdef) then
    raise exception 'bootstrap ACL / invoker semantics failed';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','94000000-0000-4000-8000-000000000001',true);
do $$
declare m jsonb; e jsonb; p jsonb; r jsonb; v_count integer; v_rejected boolean := false;
begin
  m := public.get_offline_account_manifest('basic');
  if (m->'datasets'->'projects'->>'count')::int <> 2 or (m->'datasets'->'tasks'->>'count')::int <> 2
    or m->'datasets' ? 'history' or m->'datasets' ? 'notifications'
    or (select count(*) from jsonb_object_keys(m->'datasets')) <> 12 then raise exception 'Basic scope incorrect'; end if;
  p := public.get_offline_account_page('projects', m->'datasets'->'projects'->>'revision',0,1);
  if jsonb_array_length(p->'rows') <> 1 or p->>'total' <> '2' then raise exception 'pagination incorrect'; end if;
  if not exists(select 1 from private.offline_account_rows('items') x where x.row_data->>'is_archived' = 'true') then raise exception 'archived items missing'; end if;
  if not exists(select 1 from private.offline_account_rows('template_items') x where x.row_data->>'title' = 'Template content') then raise exception 'template items missing'; end if;
  if not exists(select 1 from private.offline_account_rows('daily_audit') x where x.row_data->'new_data'->>'percentage' = '40') then raise exception 'daily audit missing'; end if;
  if exists(select 1 from private.offline_account_rows('daily_audit') x where (x.row_data->>'created_at')::timestamptz < (m->>'day_start')::timestamptz) then raise exception 'Basic audit too broad'; end if;
  e := public.get_offline_account_manifest('extended');
  if (select count(*) from jsonb_object_keys(e->'datasets')) <> 15 then raise exception 'Extended scope incorrect'; end if;
  if exists(select 1 from private.offline_account_rows('history') x where (x.row_data->>'created_at')::timestamptz < statement_timestamp()-interval '90 days') then raise exception 'history exceeds 90 days'; end if;
  select count(*) into v_count from private.offline_account_rows('notifications') x where x.row_data->>'is_read' = 'true';
  if v_count <> 100 then raise exception 'read notification window incorrect: %',v_count; end if;
  select count(*) into v_count from private.offline_account_rows('notifications') x where x.row_data->>'is_read' = 'false';
  if v_count < 205 then raise exception 'unread notifications truncated'; end if;
  select count(*) into v_count from private.offline_account_rows('last_editors');
  if v_count < 1 then raise exception 'last editors missing'; end if;
  begin perform public.get_offline_account_page('items','old-revision',0,500); exception when sqlstate 'PT409' then v_rejected := true; end;
  if not v_rejected then raise exception 'changed snapshot accepted old offset'; end if;
end $$;

-- One exact snapshot is reused across every dataset. Repeated calls retain
-- revision/pagination guards, including the PostgreSQL microsecond boundary.
do $$
declare m jsonb; p jsonb; n text; i integer; d text; rejected boolean := false;
begin
  m := public.get_offline_account_manifest('extended', null::timestamptz);
  for i in 1..20 loop
    for n in select jsonb_object_keys(m->'datasets') loop
      p := public.get_offline_account_page(n,m->'datasets'->n->>'revision',(m->>'snapshot_at')::timestamptz,0,500);
      if p->>'revision' <> m->'datasets'->n->>'revision' or p->>'total' <> m->'datasets'->n->>'count' then
        raise exception 'unstable revision for %',n;
      end if;
    end loop;
  end loop;
  begin
    perform public.get_offline_account_page('items','stale',(m->>'snapshot_at')::timestamptz,500,500);
  exception when sqlstate 'PT409' then
    get stacked diagnostics d = pg_exception_detail;
    rejected := d::jsonb->>'dataset' = 'items' and d::jsonb->>'offset' = '500'
      and d::jsonb->>'expected_revision' = 'stale'
      and d::jsonb->>'actual_revision' = m->'datasets'->'items'->>'revision';
  end;
  if not rejected then raise exception 'conflict diagnostics missing'; end if;
  rejected := false;
  begin perform public.get_offline_account_manifest('basic',statement_timestamp()-interval '31 minutes');
  exception when sqlstate 'PT409' then rejected := true; end;
  if not rejected then raise exception 'expired snapshot accepted'; end if;
  rejected := false;
  begin perform public.get_offline_account_manifest('basic',statement_timestamp()+interval '1 minute');
  exception when sqlstate '22023' then rejected := true; end;
  if not rejected then raise exception 'future snapshot accepted'; end if;
end $$;

reset role;
select set_config('test.snapshot_at',(clock_timestamp()-interval '10 seconds')::text,true);
-- The row would disappear if the 90-day lower boundary moved to wall time.
insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,created_at)
values (:'active_project','94000000-0000-4000-8000-000000000001','updated','task_item',:'item',
  current_setting('test.snapshot_at')::timestamptz-interval '90 days'+interval '1 microsecond');
set local role authenticated;
do $$
declare s timestamptz := current_setting('test.snapshot_at')::timestamptz; m jsonb; p jsonb;
begin
  m := public.get_offline_account_manifest('extended',s);
  if (m->>'history_start')::timestamptz <> s-interval '90 days'
    or (m->>'day_start')::timestamptz <> date_trunc('day',s at time zone 'Etc/GMT-3') at time zone 'Etc/GMT-3' then
    raise exception 'snapshot windows drifted';
  end if;
  if not exists(select 1 from private.offline_account_rows('history',s) r
    where (r.row_data->>'created_at')::timestamptz = s-interval '90 days'+interval '1 microsecond') then
    raise exception 'history boundary row lost';
  end if;
  if exists(select 1 from private.offline_account_rows('daily_audit',s) r where (r.row_data->>'created_at')::timestamptz > s)
    or exists(select 1 from private.offline_account_rows('history',s) r where (r.row_data->>'created_at')::timestamptz > s) then
    raise exception 'snapshot upper boundary ignored';
  end if;
  p := public.get_offline_account_page('history',m->'datasets'->'history'->>'revision',s,0,500);
  if p->>'revision' <> m->'datasets'->'history'->>'revision' then raise exception 'history time mismatch'; end if;
end $$;

reset role;
do $$ declare p record; r text; begin
  for p in select fn.oid,fn.prosecdef from pg_proc fn join pg_namespace n on n.oid=fn.pronamespace
    where n.nspname in ('public','private') and fn.proname in
    ('get_offline_account_manifest','get_offline_account_page','offline_account_rows','offline_dataset_revision') loop
    if p.prosecdef or not has_function_privilege('authenticated',p.oid,'EXECUTE') then raise exception 'invoker/auth grant changed'; end if;
    foreach r in array array['anon','service_role'] loop
      if has_function_privilege(r,p.oid,'EXECUTE') then raise exception 'unexpected bootstrap grant for %',r; end if;
    end loop;
  end loop;
end $$;
set local role authenticated;

-- Inherited membership grants checklist access without a separate task row.
-- Own override is visible to normal SELECT, but the management list is not.
select set_config('request.jwt.claim.sub','94000000-0000-4000-8000-000000000002',true);
do $$
declare m jsonb; n text; direct_count bigint; preload_count bigint;
begin
  m := public.get_offline_account_manifest('extended');
  if m->'datasets'->'projects'->>'count' <> '1' or m->'datasets'->'overrides'->>'count' <> '0' then raise exception 'viewer scope/override disclosure'; end if;
  if not exists(select 1 from private.offline_account_rows('roles') r where r.row_data->>'role' = 'member') then raise exception 'effective override role missing'; end if;
  foreach n in array array['projects','tasks','items','members','profiles','assignees','history'] loop
    select count(*) into preload_count from private.offline_account_rows(n);
    execute case n when 'items' then 'select count(*) from public.task_items'
      when 'members' then 'select count(*) from public.project_members'
      when 'assignees' then 'select count(*) from public.task_assignees'
      when 'history' then 'select count(*) from public.audit_log where project_id is not null and created_at >= statement_timestamp()-interval ''90 days'''
      else 'select count(*) from public.' || quote_ident(n) end into direct_count;
    if preload_count > direct_count then raise exception 'bootstrap expanded RLS for %',n; end if;
  end loop;
end $$;

select set_config('test.viewer_manifest', public.get_offline_account_manifest('basic',null::timestamptz)::text,true);
reset role;
delete from public.project_members where project_id = :'active_project' and user_id = '94000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub','94000000-0000-4000-8000-000000000002',true);
do $$ declare m jsonb; old jsonb := current_setting('test.viewer_manifest')::jsonb; rejected boolean := false; begin
  m := public.get_offline_account_manifest('basic');
  if m->'datasets'->'projects'->>'count' <> '0' or m->'datasets'->'tasks'->>'count' <> '0' or m->'datasets'->'items'->>'count' <> '0' then raise exception 'revoked access survived bootstrap'; end if;
  begin perform public.get_offline_account_page('items',old->'datasets'->'items'->>'revision',(old->>'snapshot_at')::timestamptz,0,500);
  exception when sqlstate 'PT409' then rejected := true; end;
  if not rejected then raise exception 'fixed snapshot bypassed a revoke'; end if;
end $$;
rollback;
\echo 'Account offline bootstrap SQL passed'
