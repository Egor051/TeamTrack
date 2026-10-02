-- Keep application snapshot conflicts out of PostgREST transaction retries.
-- Additive protocol; RLS and SECURITY INVOKER remain authoritative.
create or replace function private.offline_account_rows(p_dataset text, p_snapshot_at timestamptz)
returns table (row_key text, row_data jsonb)
language plpgsql stable security invoker set search_path = '' set timezone = 'UTC' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  case p_dataset
  when 'profile' then
    return query select p.id::text, to_jsonb(p) from public.profiles p where p.id = auth.uid();
  when 'projects' then
    return query select p.id::text, to_jsonb(p) || jsonb_build_object('role', m.role)
      from public.projects p join public.project_members m on m.project_id = p.id and m.user_id = auth.uid();
  when 'members' then
    return query select m.project_id::text || ':' || m.user_id::text, to_jsonb(m) from public.project_members m;
  when 'profiles' then
    return query select p.id::text, to_jsonb(p) from public.profiles p
      where p.id = auth.uid() or exists (select 1 from public.project_members m where m.user_id = p.id)
        or exists (select 1 from public.task_assignees a where a.user_id = p.id);
  when 'tasks' then
    return query select t.id::text, to_jsonb(t) from public.tasks t;
  when 'roles' then
    return query select t.id::text, jsonb_build_object('task_id', t.id, 'role', public.get_my_task_role(t.id)) from public.tasks t;
  when 'overrides' then
    return query select m.task_id::text || ':' || m.user_id::text,
      jsonb_build_object('task_id', m.task_id, 'user_id', m.user_id, 'role_override', m.role_override, 'set_by', m.set_by, 'set_at', m.set_at)
      from public.task_members m join public.tasks t on t.id = m.task_id
      join public.project_members pm on pm.project_id = t.project_id and pm.user_id = auth.uid()
      where pm.role in ('owner', 'admin') and m.role_override is not null;
  when 'assignees' then
    return query select a.task_id::text || ':' || a.user_id::text, to_jsonb(a) from public.task_assignees a;
  when 'items' then
    return query select i.id::text, to_jsonb(i) from public.task_items i;
  when 'templates' then
    return query select t.id::text, to_jsonb(t) from public.list_task_templates() t;
  when 'template_items' then
    return query select i.id::text, to_jsonb(i) || jsonb_build_object('position', i.template_position)
      from public.list_task_templates() t cross join lateral public.list_task_template_items(t.id) i;
  when 'daily_audit' then
    return query select lpad(a.id::text, 20, '0'), to_jsonb(a) from public.audit_log a
      where a.entity_type = 'task_item'
        and a.created_at >= date_trunc('day', p_snapshot_at at time zone 'Etc/GMT-3') at time zone 'Etc/GMT-3'
        and a.created_at <= p_snapshot_at;
  when 'history' then
    return query select lpad(a.id::text, 20, '0'), to_jsonb(a) from public.audit_log a
      where a.project_id is not null and a.created_at >= p_snapshot_at - interval '90 days'
        and a.created_at <= p_snapshot_at;
  when 'notifications' then
    return query select n.id::text, to_jsonb(n) from public.notifications n where n.user_id = auth.uid() and n.created_at <= p_snapshot_at and
      (not n.is_read or n.id in (select r.id from public.notifications r where r.user_id = auth.uid() and r.is_read and r.created_at <= p_snapshot_at
        order by r.created_at desc, r.id desc limit 100));
  when 'last_editors' then
    return query select e.task_item_id::text, to_jsonb(e) || jsonb_build_object('task_id', t.id)
      from public.tasks t cross join lateral public.list_task_item_last_editors(t.id) e;
  else raise exception 'unknown offline dataset' using errcode = '22023';
  end case;
end $$;

-- Retain old signatures. New clients carry the exact server timestamp,
-- including microseconds, and verify in the same logical time window.
create or replace function private.offline_account_rows(p_dataset text)
returns table (row_key text, row_data jsonb)
language sql stable security invoker set search_path = '' as $$
  select * from private.offline_account_rows(p_dataset, statement_timestamp())
$$;

create or replace function private.offline_dataset_revision(p_dataset text, p_hash text, p_snapshot_at timestamptz)
returns text language sql stable security invoker set search_path = '' as $$
  select md5(p_hash || case when p_dataset = 'daily_audit'
    then to_char(p_snapshot_at at time zone 'Etc/GMT-3', 'YYYY-MM-DD') else '' end)
$$;
create or replace function private.offline_dataset_revision(p_dataset text, p_hash text)
returns text language sql stable security invoker set search_path = '' as $$
  select private.offline_dataset_revision(p_dataset, p_hash, statement_timestamp())
$$;

create or replace function public.get_offline_account_manifest(p_scheme text, p_snapshot_at timestamptz)
returns jsonb language plpgsql stable security invoker set search_path = '' set timezone = 'UTC' as $$
declare
  v_snapshot_at timestamptz := coalesce(p_snapshot_at, statement_timestamp());
  v_dataset text; v_count bigint; v_hash text; v_pages jsonb; v_datasets jsonb := '{}'::jsonb;
  v_names text[] := array['profile','projects','members','profiles','tasks','roles','overrides','assignees','items','templates','template_items','daily_audit'];
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_scheme not in ('basic','extended') or p_scheme is null then raise exception 'invalid offline scheme' using errcode = '22023'; end if;
  if v_snapshot_at > statement_timestamp() then raise exception 'invalid snapshot time' using errcode = '22023'; end if;
  if v_snapshot_at < statement_timestamp() - interval '30 minutes' then
    raise exception 'offline snapshot expired' using errcode = 'PT409';
  end if;
  if p_scheme = 'extended' then v_names := v_names || array['history','notifications','last_editors']; end if;
  foreach v_dataset in array v_names loop
    with rows as materialized (select r.row_key, md5(r.row_data::text) as hash,
      (row_number() over (order by r.row_key) - 1) / 500 as page from private.offline_account_rows(v_dataset, v_snapshot_at) r),
    pages as (select page, md5(string_agg(hash, '' order by row_key)) as hash from rows group by page)
    select count(*), coalesce(string_agg(r.hash, '' order by r.row_key), ''),
      coalesce((select jsonb_agg(p.hash order by p.page) from pages p), '[]'::jsonb)
      into v_count, v_hash, v_pages from rows r;
    v_datasets := v_datasets || jsonb_build_object(v_dataset, jsonb_build_object('count', v_count,
      'revision', private.offline_dataset_revision(v_dataset, v_hash, v_snapshot_at), 'pages', v_pages));
  end loop;
  return jsonb_build_object('schema_version', 1, 'user_id', auth.uid(), 'generated_at', statement_timestamp(),
    'snapshot_at', v_snapshot_at,
    'day_start', date_trunc('day', v_snapshot_at at time zone 'Etc/GMT-3') at time zone 'Etc/GMT-3',
    'history_start', v_snapshot_at - interval '90 days', 'datasets', v_datasets);
end $$;

create or replace function public.get_offline_account_manifest(p_scheme text default 'basic')
returns jsonb language sql stable security invoker set search_path = '' as $$
  select public.get_offline_account_manifest(p_scheme, null::timestamptz)
$$;

create or replace function public.get_offline_account_page(p_dataset text, p_revision text, p_snapshot_at timestamptz,
  p_offset integer default 0, p_limit integer default 500)
returns jsonb language plpgsql stable security invoker set search_path = '' set timezone = 'UTC' as $$
declare v_result jsonb; v_snapshot_at timestamptz := coalesce(p_snapshot_at, statement_timestamp());
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_offset is null or p_offset < 0 or p_limit is null or p_limit not between 1 and 500 then
    raise exception 'invalid offline pagination' using errcode = '22023';
  end if;
  if v_snapshot_at > statement_timestamp() then raise exception 'invalid snapshot time' using errcode = '22023'; end if;
  if v_snapshot_at < statement_timestamp() - interval '30 minutes' then
    raise exception 'offline snapshot expired' using errcode = 'PT409';
  end if;
  -- Current RLS remains authoritative. Mutable rows/access changes reject the
  -- old offset. Fixed windows never waive revision or pagination validation.
  with rows as materialized (select * from private.offline_account_rows(p_dataset, v_snapshot_at)),
  version as (select count(*) as total, private.offline_dataset_revision(p_dataset,
      coalesce(string_agg(md5(row_data::text), '' order by row_key), ''), v_snapshot_at) as revision from rows),
  page as (select row_data, row_key from rows order by row_key offset p_offset limit p_limit)
  select jsonb_build_object('revision', v.revision, 'total', v.total, 'offset', p_offset,
    'rows', coalesce((select jsonb_agg(row_data order by row_key) from page), '[]'::jsonb))
    into v_result from version v;
  if p_revision is null or v_result->>'revision' <> p_revision then
    -- 40001 is an engine error: PostgREST 14 retries it indefinitely.
    -- PT409 returns one HTTP conflict; bounded recovery belongs to the client.
    raise exception 'offline snapshot changed' using errcode = 'PT409',
      detail = jsonb_build_object('dataset',p_dataset,'offset',p_offset,
        'expected_revision',p_revision,'actual_revision',v_result->>'revision','snapshot_at',v_snapshot_at)::text,
      hint = 'Refresh the account manifest before restarting this dataset.';
  end if;
  return v_result;
end $$;

create or replace function public.get_offline_account_page(p_dataset text, p_revision text, p_offset integer default 0, p_limit integer default 500)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select public.get_offline_account_page(p_dataset, p_revision, null::timestamptz, p_offset, p_limit)
$$;

revoke all on function private.offline_account_rows(text,timestamptz), private.offline_account_rows(text),
  private.offline_dataset_revision(text,text,timestamptz), private.offline_dataset_revision(text,text),
  public.get_offline_account_manifest(text,timestamptz), public.get_offline_account_manifest(text),
  public.get_offline_account_page(text,text,timestamptz,integer,integer), public.get_offline_account_page(text,text,integer,integer)
  from public, anon, service_role;
grant execute on function private.offline_account_rows(text,timestamptz), private.offline_account_rows(text),
  private.offline_dataset_revision(text,text,timestamptz), private.offline_dataset_revision(text,text),
  public.get_offline_account_manifest(text,timestamptz), public.get_offline_account_manifest(text),
  public.get_offline_account_page(text,text,timestamptz,integer,integer), public.get_offline_account_page(text,text,integer,integer)
  to authenticated;
notify pgrst, 'reload schema';
