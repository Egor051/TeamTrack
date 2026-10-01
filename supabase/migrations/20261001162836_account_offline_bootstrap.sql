-- Read-only, caller-scoped bootstrap. No replication tables or write protocol.
-- Invoker functions retain table RLS; existing template/role/editor RPCs retain
-- their established permission contracts. Never select receipts/auth/actions.
create or replace function private.offline_account_rows(p_dataset text)
returns table (row_key text, row_data jsonb)
language plpgsql stable security invoker set search_path = '' as $$
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
        and a.created_at >= date_trunc('day', statement_timestamp() at time zone 'Etc/GMT-3') at time zone 'Etc/GMT-3'
        and a.created_at <= statement_timestamp();
  when 'history' then
    return query select lpad(a.id::text, 20, '0'), to_jsonb(a) from public.audit_log a
      where a.project_id is not null and a.created_at >= statement_timestamp() - interval '90 days'
        and a.created_at <= statement_timestamp();
  when 'notifications' then
    return query select n.id::text, to_jsonb(n) from public.notifications n where n.user_id = auth.uid() and
      (not n.is_read or n.id in (select r.id from public.notifications r where r.user_id = auth.uid() and r.is_read
        order by r.created_at desc, r.id desc limit 100));
  when 'last_editors' then
    return query select e.task_item_id::text, to_jsonb(e) || jsonb_build_object('task_id', t.id)
      from public.tasks t cross join lateral public.list_task_item_last_editors(t.id) e;
  else raise exception 'unknown offline dataset' using errcode = '22023';
  end case;
end $$;

create or replace function private.offline_dataset_revision(p_dataset text, p_hash text)
returns text language sql stable security invoker set search_path = '' as $$
  select md5(p_hash || case when p_dataset = 'daily_audit'
    then to_char(statement_timestamp() at time zone 'Etc/GMT-3', 'YYYY-MM-DD') else '' end)
$$;

create or replace function public.get_offline_account_manifest(p_scheme text default 'basic')
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_dataset text; v_count bigint; v_hash text; v_pages jsonb; v_datasets jsonb := '{}'::jsonb;
  v_names text[] := array['profile','projects','members','profiles','tasks','roles','overrides','assignees','items','templates','template_items','daily_audit'];
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_scheme not in ('basic','extended') or p_scheme is null then raise exception 'invalid offline scheme' using errcode = '22023'; end if;
  if p_scheme = 'extended' then v_names := v_names || array['history','notifications','last_editors']; end if;
  foreach v_dataset in array v_names loop
    with rows as materialized (select r.row_key, md5(r.row_data::text) as hash,
      (row_number() over (order by r.row_key) - 1) / 500 as page from private.offline_account_rows(v_dataset) r),
    pages as (select page, md5(string_agg(hash, '' order by row_key)) as hash from rows group by page)
    select count(*), coalesce(string_agg(r.hash, '' order by r.row_key), ''),
      coalesce((select jsonb_agg(p.hash order by p.page) from pages p), '[]'::jsonb)
      into v_count, v_hash, v_pages from rows r;
    v_datasets := v_datasets || jsonb_build_object(v_dataset, jsonb_build_object('count', v_count,
      'revision', private.offline_dataset_revision(v_dataset, v_hash), 'pages', v_pages));
  end loop;
  return jsonb_build_object('schema_version', 1, 'user_id', auth.uid(), 'generated_at', statement_timestamp(),
    'day_start', date_trunc('day', statement_timestamp() at time zone 'Etc/GMT-3') at time zone 'Etc/GMT-3',
    'history_start', statement_timestamp() - interval '90 days', 'datasets', v_datasets);
end $$;

create or replace function public.get_offline_account_page(p_dataset text, p_revision text, p_offset integer default 0, p_limit integer default 500)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_offset is null or p_offset < 0 or p_limit is null or p_limit not between 1 and 500 then
    raise exception 'invalid offline pagination' using errcode = '22023';
  end if;
  -- Materialize once per request: fingerprint and page see the same MVCC
  -- snapshot. A changed dataset rejects the old offset rather than skipping
  -- or duplicating rows after a delete/insert/revoke during pagination.
  with rows as materialized (select * from private.offline_account_rows(p_dataset)),
  version as (select count(*) as total, private.offline_dataset_revision(p_dataset,
      coalesce(string_agg(md5(row_data::text), '' order by row_key), '')) as revision from rows),
  page as (select row_data, row_key from rows order by row_key offset p_offset limit p_limit)
  select jsonb_build_object('revision', v.revision, 'total', v.total, 'offset', p_offset,
    'rows', coalesce((select jsonb_agg(row_data order by row_key) from page), '[]'::jsonb))
    into v_result from version v;
  if p_revision is null or v_result->>'revision' <> p_revision then
    raise exception 'offline snapshot changed' using errcode = '40001';
  end if;
  return v_result;
end $$;

revoke all on function private.offline_account_rows(text), private.offline_dataset_revision(text,text),
  public.get_offline_account_manifest(text), public.get_offline_account_page(text,text,integer,integer) from public, anon, service_role;
grant execute on function private.offline_account_rows(text), private.offline_dataset_revision(text,text),
  public.get_offline_account_manifest(text), public.get_offline_account_page(text,text,integer,integer) to authenticated;
