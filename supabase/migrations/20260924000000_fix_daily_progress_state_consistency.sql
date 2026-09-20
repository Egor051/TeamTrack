-- Keep the persisted checklist state, percentage audit snapshots, and daily
-- progress calculation on the same final value.

create or replace function public.set_task_item_percentage(
    p_task_item_id uuid,
    p_percentage integer
)
returns integer
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    r_item public.task_items%rowtype;
    v_task public.tasks%rowtype;
    v_completed boolean := p_percentage = 100;
begin
    if p_percentage is null or p_percentage not between 0 and 100 then
        raise exception 'percentage must be between 0 and 100';
    end if;

    select * into r_item
      from public.task_items
     where id = p_task_item_id
     for update;
    if not found or not private.can_edit_task(r_item.task_id) then
        raise exception 'no access to task item' using errcode = 'insufficient_privilege';
    end if;

    select * into v_task from public.tasks where id = r_item.task_id;
    if r_item.is_archived or v_task.status = 'archived' or not private.project_is_active(v_task.project_id) then
        raise exception 'task item is archived';
    end if;
    if r_item.percentage = p_percentage and r_item.is_completed = v_completed then
        return p_percentage;
    end if;

    update public.task_items
       set percentage = p_percentage,
           is_completed = v_completed
     where id = r_item.id;

    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_task.project_id,
        v_user,
        'updated',
        'task_item',
        r_item.id,
        jsonb_build_object('percentage', r_item.percentage, 'is_completed', r_item.is_completed),
        jsonb_build_object('percentage', p_percentage, 'is_completed', v_completed)
    );
    return p_percentage;
end;
$$;

create or replace function public.set_task_item_state(
    p_task_item_id uuid,
    p_completed boolean
)
returns boolean
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_task_id uuid;
    v_project_id uuid;
    v_task public.tasks%rowtype;
    r_item public.task_items%rowtype;
    v_action public.item_action_type;
    v_new_percentage integer := case when p_completed then 100 else 0 end;
begin
    select task_id into v_task_id from public.task_items where id = p_task_item_id;
    if not found then
        raise exception 'no access to task item' using errcode = 'insufficient_privilege';
    end if;
    v_project_id := private.task_project_id(v_task_id);
    perform private.lock_project(v_project_id);
    v_task := private.lock_task(v_task_id);
    select * into r_item from public.task_items where id = p_task_item_id for update;

    if not private.has_task_access(r_item.task_id) then
        raise exception 'no access to task item' using errcode = 'insufficient_privilege';
    end if;
    if private.project_role_of(v_task.project_id) = 'viewer' then
        raise exception 'viewers cannot modify items' using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived' or not private.project_is_active(v_task.project_id) or r_item.is_archived then
        raise exception 'task is archived';
    end if;
    if r_item.is_completed = p_completed and r_item.percentage = v_new_percentage then
        return p_completed;
    end if;

    update public.task_items
       set percentage = v_new_percentage,
           is_completed = p_completed
     where id = r_item.id;

    v_action := case when p_completed then 'checked' else 'unchecked' end::public.item_action_type;
    if r_item.is_completed is distinct from p_completed then
        insert into public.item_actions (project_id, task_id, task_item_id, user_id, action)
        values (v_task.project_id, v_task.id, r_item.id, v_user, v_action);
    end if;
    insert into public.audit_log (project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_task.project_id,
        v_user,
        v_action::text::public.audit_action,
        'task_item',
        r_item.id,
        jsonb_build_object('percentage', r_item.percentage, 'is_completed', r_item.is_completed),
        jsonb_build_object('percentage', v_new_percentage, 'is_completed', p_completed)
    );
    return p_completed;
end;
$$;
