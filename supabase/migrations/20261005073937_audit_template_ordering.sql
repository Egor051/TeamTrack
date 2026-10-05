-- AUD-05/06/07: serialize ordering at the parent and keep it separate from text.
begin;
lock table public.task_template_items in access exclusive mode;

-- Legal legacy ties and very large/fractional positions retain their visible
-- order/content. Record the repair by appending history, never rewriting it.
with ranked as materialized (
  select id, template_id, position as old_position,
    row_number() over (partition by template_id order by position, created_at, id)::numeric as new_position
  from public.task_template_items
), repaired as (
  update public.task_template_items i set position = r.new_position
  from ranked r where i.id = r.id and i.position is distinct from r.new_position
  returning i.id
)
insert into public.audit_log(user_id, action, entity_type, entity_id, old_data, new_data)
select null, 'reordered', 'task_template_item', r.id,
  jsonb_build_object('template_id', r.template_id, 'position', r.old_position),
  jsonb_build_object('template_id', r.template_id, 'position', r.new_position, 'migration', 'audit_template_ordering')
from ranked r join repaired using (id);

alter table public.task_template_items drop constraint task_template_items_position_chk;
alter table public.task_template_items add constraint task_template_items_position_chk
  check (position >= 0 and position not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));
-- Deferrable IMMEDIATE checks uniqueness at statement end, so one UPDATE can
-- swap two positions without an intermediate collision. Commit remains strict.
alter table public.task_template_items add constraint task_template_items_template_position_key
  unique (template_id, position) deferrable initially immediate;

create function public.move_task_template_item(p_item_id uuid, p_direction integer)
returns void language plpgsql security definer set search_path = private, public as $$
declare
  v_user uuid := private.require_auth();
  v_template_id uuid;
  v_template public.task_templates%rowtype;
  v_item public.task_template_items%rowtype;
  v_neighbor public.task_template_items%rowtype;
begin
  if p_direction is null or p_direction not in (-1, 1) then
    raise exception 'direction must be -1 or 1' using errcode = '22023';
  end if;
  select template_id into v_template_id from public.task_template_items where id = p_item_id;
  if not found then raise exception 'template item not found'; end if;
  -- Same parent-before-item order as create/update/delete/copy RPCs.
  select * into v_template from public.task_templates where id = v_template_id for update;
  if not found or v_template.archived_at is not null or v_template.created_by <> v_user then
    raise exception 'no permission to edit template item' using errcode = '42501';
  end if;
  select * into v_item from public.task_template_items where id = p_item_id for update;
  if not found or v_item.template_id <> v_template_id then raise exception 'template item not found'; end if;
  if p_direction = -1 then
    select * into v_neighbor from public.task_template_items
    where template_id = v_template_id and position < v_item.position order by position desc limit 1 for update;
  else
    select * into v_neighbor from public.task_template_items
    where template_id = v_template_id and position > v_item.position order by position limit 1 for update;
  end if;
  if not found then return; end if;
  update public.task_template_items
    set position = case when id = v_item.id then v_neighbor.position else v_item.position end
    where id in (v_item.id, v_neighbor.id);
  insert into public.audit_log(user_id, action, entity_type, entity_id, old_data, new_data)
  values
    (v_user, 'reordered', 'task_template_item', v_item.id,
      jsonb_build_object('template_id', v_template_id, 'position', v_item.position),
      jsonb_build_object('template_id', v_template_id, 'position', v_neighbor.position)),
    (v_user, 'reordered', 'task_template_item', v_neighbor.id,
      jsonb_build_object('template_id', v_template_id, 'position', v_neighbor.position),
      jsonb_build_object('template_id', v_template_id, 'position', v_item.position));
end;
$$;
revoke all on function public.move_task_template_item(uuid, integer) from public, anon, service_role;
grant execute on function public.move_task_template_item(uuid, integer) to authenticated;

create or replace function public.create_task_from_template(
  p_project_id uuid, p_template_id uuid, p_title text default null, p_description text default null
)
returns uuid language plpgsql security definer set search_path = private, public as $$
declare
  v_user uuid := private.require_auth();
  v_task_id uuid;
  v_project public.projects%rowtype;
  v_role public.project_role;
  v_template public.task_templates%rowtype;
  v_item record;
begin
  v_project := private.lock_project_state(p_project_id);
  v_role := private.lock_project_role(p_project_id, v_user);
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'only owner/admin can create stages from templates' using errcode = '42501';
  end if;
  if v_project.status <> 'active' then raise exception 'project is archived'; end if;
  select * into v_template from public.task_templates where id = p_template_id and archived_at is null for update;
  if not found then raise exception 'template not found'; end if;
  v_task_id := public.create_task(p_project_id, coalesce(nullif(btrim(p_title), ''), v_template.name),
    case when p_description is null then v_template.description else nullif(btrim(p_description), '') end);
  -- Template numeric values may exceed the task_items numeric(30,15) range or
  -- collapse at its precision. Copy their order into distinct dense positions.
  for v_item in select title, description,
      row_number() over (order by position, created_at, id)::numeric as position
    from public.task_template_items where template_id = p_template_id order by position, created_at, id
  loop
    insert into public.task_items(task_id, title, description, position, is_completed, percentage, comment)
    values (v_task_id, v_item.title, v_item.description, v_item.position, false, 0, null);
  end loop;
  insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, new_data)
  values (p_project_id, v_user, 'created', 'task_from_template', v_task_id,
    jsonb_build_object('task_id', v_task_id, 'template_id', p_template_id));
  return v_task_id;
end;
$$;
revoke all on function public.create_task_from_template(uuid, uuid, text, text) from public, anon, service_role;
grant execute on function public.create_task_from_template(uuid, uuid, text, text) to authenticated;
commit;
