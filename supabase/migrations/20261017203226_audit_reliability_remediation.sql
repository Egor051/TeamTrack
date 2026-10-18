-- Compare-and-set overloads keep legacy callers compatible. Authorization and
-- mutation side effects remain in the existing, locked mutation functions.
create function public.update_project(p_project_id uuid, p_name text, p_description text,
  p_expected_name text, p_expected_description text)
returns void language plpgsql security definer set search_path = private, public as $$
declare v_user uuid := private.require_auth(); v_row public.projects%rowtype;
begin
  v_row := private.lock_project_state(p_project_id);
  if private.lock_project_role(p_project_id, v_user) not in ('owner','admin')
     or not private.is_project_admin(p_project_id) then
    raise exception 'project admin role required' using errcode = '42501';
  end if;
  if v_row.name is distinct from p_expected_name
     or coalesce(v_row.description,'') is distinct from coalesce(p_expected_description,'') then
    raise exception 'Проект изменён другим участником. Обновите данные, ваш черновик сохранён.' using errcode = 'PT409';
  end if;
  perform public.update_project(p_project_id, p_name, p_description);
end; $$;

create function public.update_task_template(p_template_id uuid, p_name text, p_description text,
  p_expected_name text, p_expected_description text)
returns void language plpgsql security definer set search_path = private, public as $$
declare v_user uuid := private.require_auth(); v_row public.task_templates%rowtype;
begin
  select * into v_row from public.task_templates where id=p_template_id for update;
  if not found or v_row.archived_at is not null then raise exception 'template not found'; end if;
  if v_row.created_by <> v_user then raise exception 'only template creator can edit it' using errcode='42501'; end if;
  if v_row.name is distinct from p_expected_name
     or coalesce(v_row.description,'') is distinct from coalesce(p_expected_description,'') then
    raise exception 'Шаблон изменён. Обновите данные, ваш черновик сохранён.' using errcode = 'PT409';
  end if;
  perform public.update_task_template(p_template_id, p_name, p_description);
end; $$;

-- Template-item editing follows the same parent-before-item lock order.
create function public.update_task_template_item(p_item_id uuid, p_title text, p_description text,
  p_expected_title text, p_expected_description text, p_position numeric default null)
returns void language plpgsql security definer set search_path = private, public as $$
declare v_user uuid := private.require_auth(); v_template_id uuid; v_template public.task_templates%rowtype;
  v_item public.task_template_items%rowtype;
begin
  select template_id into v_template_id from public.task_template_items where id=p_item_id;
  if not found then raise exception 'template item not found'; end if;
  select * into v_template from public.task_templates where id=v_template_id for update;
  if not found or v_template.archived_at is not null or v_template.created_by<>v_user then
    raise exception 'no permission to edit template item' using errcode='42501';
  end if;
  select * into v_item from public.task_template_items where id=p_item_id for update;
  if not found or v_item.template_id<>v_template_id then raise exception 'template item not found'; end if;
  if v_item.title is distinct from p_expected_title or coalesce(v_item.description,'') is distinct from coalesce(p_expected_description,'') then
    raise exception 'Пункт шаблона изменён. Ваш черновик сохранён.' using errcode='PT409';
  end if;
  perform public.update_task_template_item(p_item_id,p_title,p_description,p_position);
end; $$;
revoke all on function public.update_task_template_item(uuid,text,text,text,text,numeric) from public,anon,service_role;
grant execute on function public.update_task_template_item(uuid,text,text,text,text,numeric) to authenticated;

-- Scalar JSON pages are not truncated by PostgREST's table-row limit. Each page
-- is read from one SQL snapshot; the content revision detects changes between
-- HTTP requests. Consumers publish/cache only a completely validated revision.
create function public.get_task_template_page(p_template_id uuid default null,
  p_offset integer default 0, p_limit integer default 500, p_revision text default null)
returns jsonb language plpgsql stable security definer set search_path = private, public as $$
declare v_user uuid := private.require_auth(); v_rows jsonb; v_revision text; v_total integer;
begin
  if p_offset is null or p_offset < 0 or p_limit is null or p_limit not between 1 and 500 then
    raise exception 'invalid template page' using errcode='22023';
  end if;
  if p_template_id is null then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc, t.id), '[]'::jsonb)
      into v_rows from public.list_task_templates() t;
  else
    if not exists(select 1 from public.task_templates where id=p_template_id and archived_at is null) then
      raise exception 'template not found' using errcode='PT404';
    end if;
    select coalesce(jsonb_agg(to_jsonb(i) order by i.template_position, i.created_at, i.id), '[]'::jsonb)
      into v_rows from public.list_task_template_items(p_template_id) i;
  end if;
  v_total := jsonb_array_length(v_rows);
  v_revision := md5(v_rows::text);
  if p_revision is not null and p_revision <> v_revision then
    raise exception 'Template changed between pages' using errcode='PT409';
  end if;
  return jsonb_build_object('revision',v_revision,'total',v_total,'offset',p_offset,
    'rows',coalesce((select jsonb_agg(row order by ord) from jsonb_array_elements(v_rows) with ordinality e(row,ord)
      where ord > p_offset and ord <= p_offset::bigint+p_limit), '[]'::jsonb));
end; $$;

revoke all on function public.update_project(uuid,text,text,text,text),
  public.update_task_template(uuid,text,text,text,text), public.get_task_template_page(uuid,integer,integer,text)
  from public, anon, service_role;
grant execute on function public.update_project(uuid,text,text,text,text),
  public.update_task_template(uuid,text,text,text,text), public.get_task_template_page(uuid,integer,integer,text)
  to authenticated;

create or replace function private.audit_log_visible(p_project_id uuid, p_entity_type text,
  p_entity_id uuid, p_old_data jsonb, p_new_data jsonb)
returns boolean language plpgsql stable security definer set search_path = private, public as $$
declare v_task_id uuid; v_template_id uuid;
begin
  if p_entity_type = 'profile' then return p_entity_id = auth.uid(); end if;
  if p_entity_type = 'task_template' then
    return exists(select 1 from public.task_templates tt where tt.id=p_entity_id and tt.created_by=auth.uid())
      or coalesce(p_new_data->>'created_by',p_old_data->>'created_by')=auth.uid()::text;
  end if;
  if p_entity_type = 'task_template_item' then
    select template_id into v_template_id from public.task_template_items where id=p_entity_id;
    if v_template_id is null then
      begin v_template_id := nullif(coalesce(p_new_data->>'template_id',p_old_data->>'template_id'),'')::uuid;
      exception when invalid_text_representation then return false; end;
    end if;
    return exists(select 1 from public.task_templates tt where tt.id=v_template_id and tt.created_by=auth.uid());
  end if;
  if p_project_id is not null and private.is_project_admin(p_project_id) then return true; end if;
  if p_entity_type in ('project','project_member') then
    return p_project_id is not null and private.is_project_member(p_project_id);
  end if;
  if p_entity_type in ('task','task_from_template') then
    return p_entity_id is not null and private.task_project_id(p_entity_id)=p_project_id and private.has_task_access(p_entity_id);
  end if;
  if p_entity_type in ('task_item','task_item_deadline') then
    select task_id into v_task_id from public.task_items where id=p_entity_id;
    -- Audit payloads are immutable and server-generated. Retain history after
    -- item deletion, but still require the surviving task and its current ACL.
    if v_task_id is null then
      begin v_task_id := nullif(coalesce(p_new_data->>'task_id',p_old_data->>'task_id'),'')::uuid;
      exception when invalid_text_representation then return false; end;
    end if;
    return v_task_id is not null and private.task_project_id(v_task_id)=p_project_id and private.has_task_access(v_task_id);
  end if;
  if p_entity_type in ('task_member','task_assignee') then
    begin v_task_id := nullif(coalesce(p_new_data->>'task_id',p_old_data->>'task_id'),'')::uuid;
    exception when invalid_text_representation then return false; end;
    return v_task_id is not null and private.task_project_id(v_task_id)=p_project_id and private.has_task_access(v_task_id);
  end if;
  return false;
end; $$;

-- Preview ordering agrees with paged editing and the transactional copy RPC.
create or replace function public.get_task_template(p_template_id uuid)
returns jsonb language sql stable security definer set search_path = private, public as $$
  select jsonb_build_object('id',t.id,'name',t.name,'description',t.description,'created_by',t.created_by,
    'created_at',t.created_at,'updated_at',t.updated_at,'items',coalesce((select jsonb_agg(to_jsonb(i)
      order by i.position,i.created_at,i.id) from public.task_template_items i where i.template_id=t.id),'[]'::jsonb))
  from public.task_templates t where t.id=p_template_id and t.archived_at is null;
$$;

-- Existing PostgREST processes must discover the new RPC overloads/pages
-- before the new client is released. Notification is delivered on commit.
notify pgrst, 'reload schema';
