-- Checklist structure is managed by project owner/admin. Members keep the
-- existing progress, checkbox and comment capabilities, but cannot mutate
-- task_items through any RPC or Data API path.

create or replace function public.create_task_item(
    p_task_id uuid,
    p_title text,
    p_description text default null,
    p_position numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
    v_task public.tasks%rowtype;
    v_id uuid;
    v_pos numeric;
begin
    perform private.lock_project(v_project_id);
    v_task := private.lock_task(p_task_id);

    if p_title is null or length(btrim(p_title)) = 0 then
        raise exception 'item title must not be blank';
    end if;
    if p_position is not null and (p_position < 0 or p_position = 'NaN'::numeric) then
        raise exception 'item position must be a non-negative finite number';
    end if;
    if not private.has_task_access(p_task_id) then
        raise exception 'no access to task' using errcode = 'insufficient_privilege';
    end if;
    if not private.is_project_admin(v_project_id) then
        raise exception 'only owner/admin can create task items' using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived' or not private.project_is_active(v_project_id) then
        raise exception 'task is archived';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('task-items:' || p_task_id::text, 0));
    if p_position is null then
        select coalesce(max(position), 0) + 1 into v_pos
          from public.task_items where task_id = p_task_id;
    else
        v_pos := p_position;
    end if;

    insert into public.task_items (task_id, title, description, position)
    values (p_task_id, btrim(p_title), nullif(btrim(p_description), ''), v_pos)
    returning id into v_id;

    insert into public.audit_log (project_id, user_id, action, entity_type, entity_id, new_data)
    values (v_project_id, v_user, 'created', 'task_item', v_id,
            jsonb_build_object('title', btrim(p_title), 'description', nullif(btrim(p_description), ''), 'position', v_pos));
    return v_id;
end
$$;

create or replace function public.update_task_item(
    p_task_item_id uuid,
    p_title text default null,
    p_description text default null,
    p_position numeric default null
)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_task_id uuid;
    v_project_id uuid;
    v_task public.tasks%rowtype;
    r public.task_items%rowtype;
    v_old jsonb := '{}'::jsonb;
    v_new jsonb := '{}'::jsonb;
    v_action public.audit_action;
begin
    select task_id into v_task_id from public.task_items where id = p_task_item_id;
    if not found then
        raise exception 'task item not found';
    end if;
    v_project_id := private.task_project_id(v_task_id);
    perform private.lock_project(v_project_id);
    v_task := private.lock_task(v_task_id);
    select * into r from public.task_items where id = p_task_item_id for update;

    if not private.has_task_access(r.task_id) then
        raise exception 'no access to task item' using errcode = 'insufficient_privilege';
    end if;
    if not private.is_project_admin(v_project_id) then
        raise exception 'only owner/admin can edit task items' using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived' or not private.project_is_active(v_project_id) or r.is_archived then
        raise exception 'task item is archived';
    end if;
    if p_position is not null and (p_position < 0 or p_position = 'NaN'::numeric) then
        raise exception 'item position must be a non-negative finite number';
    end if;
    if p_title is not null and p_title is distinct from r.title then
        if length(btrim(p_title)) = 0 then
            raise exception 'item title must not be blank';
        end if;
        v_old := v_old || jsonb_build_object('title', r.title);
        v_new := v_new || jsonb_build_object('title', btrim(p_title));
    end if;
    if p_description is not null and nullif(btrim(p_description), '') is distinct from r.description then
        v_old := v_old || jsonb_build_object('description', r.description);
        v_new := v_new || jsonb_build_object('description', nullif(btrim(p_description), ''));
    end if;
    if p_position is not null and p_position is distinct from r.position then
        v_old := v_old || jsonb_build_object('position', r.position);
        v_new := v_new || jsonb_build_object('position', p_position);
    end if;
    if v_new = '{}'::jsonb then
        return;
    end if;

    update public.task_items
       set title = case when p_title is null then title else btrim(p_title) end,
           description = case when p_description is null then description else nullif(btrim(p_description), '') end,
           position = coalesce(p_position, position)
     where id = r.id;

    v_action := case when v_old ? 'position' then 'reordered' else 'updated' end::public.audit_action;
    insert into public.audit_log (project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (v_project_id, v_user, v_action, 'task_item', r.id, v_old, v_new);
end
$$;

-- Stage order is persisted on the task row. Existing stages retain their
-- chronological order when the column is introduced.
alter table public.tasks add column if not exists position numeric(30,15);

with ranked as (
    select id,
           row_number() over (partition by project_id order by created_at asc, id asc)::numeric as position
      from public.tasks
)
update public.tasks t
   set position = ranked.position
  from ranked
 where ranked.id = t.id
   and t.position is null;

alter table public.tasks alter column position set default 1;
alter table public.tasks alter column position set not null;
alter table public.tasks drop constraint if exists tasks_position_valid;
alter table public.tasks add constraint tasks_position_valid
    check (position >= 0 and position <> 'NaN'::numeric);
create index if not exists idx_tasks_project_position
    on public.tasks(project_id, position, created_at, id);

create or replace function public.create_task(
    p_project_id uuid,
    p_title text,
    p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_id uuid;
    v_position numeric;
begin
    perform private.lock_project(p_project_id);
    if p_title is null or length(btrim(p_title)) = 0 then
        raise exception 'task title must not be blank';
    end if;
    if not private.is_project_member(p_project_id) then
        raise exception 'not a project member' using errcode = 'insufficient_privilege';
    end if;
    if private.project_role_of(p_project_id) = 'viewer' then
        raise exception 'viewers cannot create tasks' using errcode = 'insufficient_privilege';
    end if;
    if not private.project_is_active(p_project_id) then
        raise exception 'project is archived';
    end if;
    select coalesce(max(position), 0) + 1 into v_position
      from public.tasks where project_id = p_project_id;

    insert into public.tasks (project_id, title, description, created_by, position)
    values (p_project_id, btrim(p_title), nullif(btrim(p_description), ''), v_user, v_position)
    returning id into v_id;

    insert into public.task_members (task_id, user_id, approved_by)
    values (v_id, v_user, v_user);
    insert into public.audit_log (project_id, user_id, action, entity_type, entity_id, new_data)
    values (p_project_id, v_user, 'created', 'task', v_id,
            jsonb_build_object('title', btrim(p_title), 'description', nullif(btrim(p_description), ''), 'position', v_position));
    return v_id;
end
$$;

create or replace function public.move_task(p_task_id uuid, p_direction integer)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_task public.tasks%rowtype;
    v_neighbor public.tasks%rowtype;
begin
    if p_direction not in (-1, 1) then
        raise exception 'direction must be -1 or 1';
    end if;

    select * into v_task from public.tasks where id = p_task_id;
    if not found then
        raise exception 'task not found';
    end if;
    perform private.lock_project(v_task.project_id);
    select * into v_task from public.tasks where id = p_task_id for update;

    if not private.is_project_admin(v_task.project_id) then
        raise exception 'only owner/admin can reorder stages' using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived' or not private.project_is_active(v_task.project_id) then
        raise exception 'task is archived';
    end if;

    if p_direction = -1 then
        select * into v_neighbor
          from public.tasks t
         where t.project_id = v_task.project_id
           and t.status <> 'archived'
           and (t.position, t.created_at, t.id) < (v_task.position, v_task.created_at, v_task.id)
         order by t.position desc, t.created_at desc, t.id desc
         limit 1
         for update;
    else
        select * into v_neighbor
          from public.tasks t
         where t.project_id = v_task.project_id
           and t.status <> 'archived'
           and (t.position, t.created_at, t.id) > (v_task.position, v_task.created_at, v_task.id)
         order by t.position asc, t.created_at asc, t.id asc
         limit 1
         for update;
    end if;

    if not found then
        return;
    end if;

    update public.tasks
       set position = case
           when id = v_task.id then v_neighbor.position
           when id = v_neighbor.id then v_task.position
           else position
       end
     where id in (v_task.id, v_neighbor.id);

    insert into public.audit_log (project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values
        (v_task.project_id, v_user, 'reordered', 'task', v_task.id,
         jsonb_build_object('position', v_task.position),
         jsonb_build_object('position', v_neighbor.position)),
        (v_neighbor.project_id, v_user, 'reordered', 'task', v_neighbor.id,
         jsonb_build_object('position', v_neighbor.position),
         jsonb_build_object('position', v_task.position));
end
$$;

-- A member may create a blank stage, but creating one from a template would
-- also create checklist rows, so that path is restricted to project admins.
create or replace function public.create_task_from_template(
    p_project_id uuid,
    p_template_id uuid,
    p_title text default null,
    p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_task_id uuid;
    v_template public.task_templates%rowtype;
    v_item record;
begin
    perform private.lock_project(p_project_id);
    if not private.is_project_admin(p_project_id) then
        raise exception 'only owner/admin can create stages from templates' using errcode = 'insufficient_privilege';
    end if;
    select * into v_template from public.task_templates where id = p_template_id and archived_at is null for update;
    if not found then
        raise exception 'template not found';
    end if;

    v_task_id := public.create_task(
        p_project_id,
        coalesce(nullif(btrim(p_title), ''), v_template.name),
        case when p_description is null then v_template.description else nullif(btrim(p_description), '') end
    );
    for v_item in
        select title, description, position
          from public.task_template_items
         where template_id = v_template.id
         order by position, created_at
    loop
        insert into public.task_items(task_id, title, description, position, is_completed, percentage, comment)
        values(v_task_id, v_item.title, v_item.description, v_item.position, false, 0, null);
    end loop;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, new_data)
    values(p_project_id, v_user, 'created', 'task_from_template', v_task_id,
           jsonb_build_object('template_id', v_template.id));
    return v_task_id;
end
$$;

revoke all on function public.move_task(uuid, integer) from public, anon;
grant execute on function public.move_task(uuid, integer) to authenticated, service_role;
