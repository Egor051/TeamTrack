-- Preserve the existing project/task lock order, grants and hierarchy.

create or replace function public.change_member_role(
    p_project_id uuid,
    p_user_id uuid,
    p_new_role public.project_role
)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_actor uuid := private.require_auth();
    v_project public.projects%rowtype;
    v_actor_role public.project_role;
    v_target_role public.project_role;
begin
    if p_user_id = v_actor then
        raise exception 'cannot change your own role' using errcode = 'insufficient_privilege';
    end if;
    v_project := private.lock_project_state(p_project_id);
    v_actor_role := private.lock_project_role(p_project_id, v_actor);
    v_target_role := private.lock_project_role(p_project_id, p_user_id);
    if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can change roles'
            using errcode = 'insufficient_privilege';
    end if;
    if v_target_role is null then
        raise exception 'target user is not a project member';
    end if;
    if v_target_role = 'owner' or p_new_role = 'owner' then
        raise exception 'the owner role can only be changed via transfer_project_ownership';
    end if;
    if v_actor_role = 'admin' and (v_target_role = 'admin' or p_new_role = 'admin') then
        raise exception 'only the owner can manage administrators'
            using errcode = 'insufficient_privilege';
    end if;
    if v_project.status <> 'active' then
        raise exception 'project is archived';
    end if;
    if v_target_role = p_new_role then
        return;
    end if;

    update public.project_members
       set role = p_new_role
     where project_id = p_project_id and user_id = p_user_id;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        p_project_id,
        v_actor,
        'role_changed',
        'project_member',
        p_user_id,
        jsonb_build_object('user_id', p_user_id, 'role', v_target_role),
        jsonb_build_object('user_id', p_user_id, 'role', p_new_role)
    );
end;
$$;

create or replace function public.set_task_member_override(
    p_task_id uuid,
    p_user_id uuid,
    p_role public.project_role
)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_actor uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_actor_role public.project_role;
    v_target_project_role public.project_role;
    v_old_override public.project_role;
begin
    if p_user_id = v_actor then
        raise exception 'cannot change your own role' using errcode = 'insufficient_privilege';
    end if;
    if v_project_id is null then
        raise exception 'task not found';
    end if;
    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(p_task_id);

    v_actor_role := private.lock_project_role(v_project_id, v_actor);
    v_target_project_role := private.lock_project_role(v_project_id, p_user_id);
    if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can manage checklist overrides'
            using errcode = 'insufficient_privilege';
    end if;
    if v_target_project_role is null then
        raise exception 'target user is not a project member';
    end if;
    if v_actor_role = 'admin' and v_target_project_role in ('owner', 'admin') then
        raise exception 'only the owner can manage owner/admin checklist overrides'
            using errcode = 'insufficient_privilege';
    end if;
    if p_role = 'owner' then
        raise exception 'owner is not a valid checklist-only override; use admin';
    end if;
    if p_role = v_target_project_role then
        raise exception 'override must differ from inherited project role; clear it instead';
    end if;
    if v_task.status = 'archived' or v_project.status <> 'active' then
        raise exception 'task is archived';
    end if;

    select tm.role_override
      into v_old_override
      from public.task_members tm
     where tm.task_id = p_task_id
       and tm.user_id = p_user_id
     for update;

    if v_old_override = p_role then
        return;
    end if;

    insert into public.task_members(task_id, user_id, set_by, set_at, role_override)
    values (p_task_id, p_user_id, v_actor, now(), p_role)
    on conflict (task_id, user_id) do update
        set role_override = excluded.role_override,
            set_by = excluded.set_by,
            set_at = excluded.set_at;

    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_project_id,
        v_actor,
        'role_changed',
        'task_member',
        p_user_id,
        jsonb_build_object(
            'task_id', p_task_id,
            'user_id', p_user_id,
            'role_override', v_old_override,
            'inherited_role', v_target_project_role
        ),
        jsonb_build_object(
            'task_id', p_task_id,
            'user_id', p_user_id,
            'role_override', p_role,
            'inherited_role', v_target_project_role
        )
    );
end;
$$;

create or replace function public.clear_task_member_override(
    p_task_id uuid,
    p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_actor uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_actor_role public.project_role;
    v_target_project_role public.project_role;
    v_old_override public.project_role;
begin
    if p_user_id = v_actor then
        raise exception 'cannot change your own role' using errcode = 'insufficient_privilege';
    end if;
    if v_project_id is null then
        raise exception 'task not found';
    end if;
    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(p_task_id);

    v_actor_role := private.lock_project_role(v_project_id, v_actor);
    v_target_project_role := private.lock_project_role(v_project_id, p_user_id);
    if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can manage checklist overrides'
            using errcode = 'insufficient_privilege';
    end if;
    if v_target_project_role is null then
        raise exception 'target user is not a project member';
    end if;
    if v_actor_role = 'admin' and v_target_project_role in ('owner', 'admin') then
        raise exception 'only the owner can manage owner/admin checklist overrides'
            using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived' or v_project.status <> 'active' then
        raise exception 'task is archived';
    end if;

    select tm.role_override
      into v_old_override
      from public.task_members tm
     where tm.task_id = p_task_id
       and tm.user_id = p_user_id
     for update;
    if v_old_override is null then
        return;
    end if;

    update public.task_members
       set role_override = null,
           set_by = v_actor,
           set_at = now()
     where task_id = p_task_id
       and user_id = p_user_id;

    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_project_id,
        v_actor,
        'role_changed',
        'task_member',
        p_user_id,
        jsonb_build_object(
            'task_id', p_task_id,
            'user_id', p_user_id,
            'role_override', v_old_override,
            'inherited_role', v_target_project_role
        ),
        jsonb_build_object(
            'task_id', p_task_id,
            'user_id', p_user_id,
            'role_override', null,
            'inherited_role', v_target_project_role
        )
    );
end;
$$;
