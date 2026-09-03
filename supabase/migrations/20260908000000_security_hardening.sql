-- TaskTrace security and integrity hardening.
-- This migration narrows audit/profile visibility, removes direct mutable table
-- writes, preserves per-task revocation history, and serializes item creation.

-- -----------------------------------------------------------------------------
-- Scoped audit visibility
-- -----------------------------------------------------------------------------

create or replace function private.audit_log_visible(
    p_project_id uuid,
    p_entity_type text,
    p_entity_id uuid,
    p_old_data jsonb,
    p_new_data jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = private, public
as $$
declare
    v_task_id uuid;
begin
    if p_entity_type in ('project', 'project_member') then
        return private.is_project_member(p_project_id);
    end if;

    if p_entity_type = 'task' then
        return p_entity_id is not null
           and private.task_project_id(p_entity_id) = p_project_id
           and private.has_task_access(p_entity_id);
    end if;

    if p_entity_type = 'task_item' then
        return exists (
            select 1
            from public.task_items ti
            where ti.id = p_entity_id
              and private.task_project_id(ti.task_id) = p_project_id
              and private.has_task_access(ti.task_id)
        );
    end if;

    if p_entity_type in ('task_member', 'task_assignee') then
        begin
            v_task_id := nullif(coalesce(p_new_data->>'task_id', p_old_data->>'task_id'), '')::uuid;
        exception when invalid_text_representation then
            return false;
        end;
        return v_task_id is not null
           and private.task_project_id(v_task_id) = p_project_id
           and private.has_task_access(v_task_id);
    end if;

    return false;
end
$$;

revoke all on function private.audit_log_visible(uuid, text, uuid, jsonb, jsonb)
    from public, anon, authenticated;
grant execute on function private.audit_log_visible(uuid, text, uuid, jsonb, jsonb)
    to authenticated;

drop policy if exists audit_log_select_project_member on public.audit_log;
create policy audit_log_select_scoped
on public.audit_log for select
to authenticated
using (private.audit_log_visible(project_id, entity_type, entity_id, old_data, new_data));

-- -----------------------------------------------------------------------------
-- Profile visibility is limited to self and shared project members.
-- -----------------------------------------------------------------------------

create or replace function private.can_view_profile(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = private, public
as $$
    select exists (
        select 1
        from public.project_members viewer
        join public.project_members target
          on target.project_id = viewer.project_id
        where viewer.user_id = auth.uid()
          and target.user_id = p_profile_id
    );
$$;

revoke all on function private.can_view_profile(uuid) from public, anon, authenticated;
grant execute on function private.can_view_profile(uuid) to authenticated;

drop policy if exists profiles_select_all on public.profiles;
create policy profiles_select_related
on public.profiles for select
to authenticated
using (id = auth.uid() or private.can_view_profile(id));

-- -----------------------------------------------------------------------------
-- Provenance columns are server-controlled. Future edits must use an RPC.
-- -----------------------------------------------------------------------------

revoke update on public.projects, public.tasks from authenticated;

-- -----------------------------------------------------------------------------
-- Keep profile metadata synchronized after auth.users metadata changes.
-- -----------------------------------------------------------------------------

create or replace function private.handle_auth_user_update()
returns trigger
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_display_name text;
begin
    select coalesce(
        nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
        nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
        p.display_name,
        nullif(btrim(split_part(coalesce(new.email, 'user'), '@', 1)), ''),
        'user'
    )
      into v_display_name
      from public.profiles p
     where p.id = new.id;

    if v_display_name is null then
        v_display_name := coalesce(
            nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
            nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
            nullif(btrim(split_part(coalesce(new.email, 'user'), '@', 1)), ''),
            'user'
        );
    end if;

    update public.profiles
       set display_name = v_display_name
     where id = new.id;
    return new;
end
$$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
    after update on auth.users
    for each row
    when (old.raw_user_meta_data is distinct from new.raw_user_meta_data)
    execute function private.handle_auth_user_update();

-- -----------------------------------------------------------------------------
-- Project member removal now records every affected task relationship.
-- -----------------------------------------------------------------------------

create or replace function public.remove_project_member(p_project_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_role public.project_role;
    v_task_id uuid;
begin
    if not private.is_project_admin(p_project_id) then
        raise exception 'only owner/admin can manage project members'
            using errcode = 'insufficient_privilege';
    end if;
    if not private.project_is_active(p_project_id) then
        raise exception 'project is archived';
    end if;

    select role into v_role
      from public.project_members
     where project_id = p_project_id and user_id = p_user_id;

    if not found then
        return;
    end if;
    if v_role = 'owner' then
        raise exception 'cannot remove the project owner - transfer ownership first';
    end if;

    for v_task_id in
        select t.id
          from public.tasks t
         where t.project_id = p_project_id
           and (
               exists (select 1 from public.task_members tm
                        where tm.task_id = t.id and tm.user_id = p_user_id)
               or exists (select 1 from public.task_assignees ta
                        where ta.task_id = t.id and ta.user_id = p_user_id)
           )
    loop
        if exists (select 1 from public.task_assignees
                   where task_id = v_task_id and user_id = p_user_id) then
            insert into public.audit_log
                (project_id, user_id, action, entity_type, entity_id, new_data)
            values
                (p_project_id, v_user, 'assignee_removed', 'task_assignee', p_user_id,
                 jsonb_build_object('task_id', v_task_id, 'user_id', p_user_id,
                                    'reason', 'project access removed'));
        end if;

        if exists (select 1 from public.task_members
                   where task_id = v_task_id and user_id = p_user_id) then
            insert into public.audit_log
                (project_id, user_id, action, entity_type, entity_id, new_data)
            values
                (p_project_id, v_user, 'access_revoked', 'task_member', p_user_id,
                 jsonb_build_object('task_id', v_task_id, 'user_id', p_user_id,
                                    'reason', 'project access removed'));
        end if;
    end loop;

    delete from public.task_assignees a
     using public.tasks t
     where a.task_id = t.id
       and t.project_id = p_project_id
       and a.user_id = p_user_id;

    delete from public.task_members m
     using public.tasks t
     where m.task_id = t.id
       and t.project_id = p_project_id
       and m.user_id = p_user_id;

    delete from public.project_members
     where project_id = p_project_id and user_id = p_user_id;

    insert into public.audit_log
        (project_id, user_id, action, entity_type, entity_id, old_data)
    values
        (p_project_id, v_user, 'member_removed', 'project_member', p_user_id,
         jsonb_build_object('user_id', p_user_id, 'role', v_role));
end
$$;

-- -----------------------------------------------------------------------------
-- Serialize automatic position allocation for concurrent item creation.
-- -----------------------------------------------------------------------------

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
    v_id uuid;
    v_pos numeric;
begin
    if p_title is null or length(btrim(p_title)) = 0 then
        raise exception 'item title must not be blank';
    end if;
    if not private.has_task_access(p_task_id) then
        raise exception 'no access to task' using errcode = 'insufficient_privilege';
    end if;
    if private.project_role_of(private.task_project_id(p_task_id)) = 'viewer' then
        raise exception 'viewers cannot create items' using errcode = 'insufficient_privilege';
    end if;
    if not private.task_is_editable(p_task_id) then
        raise exception 'task is archived';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('task-items:' || p_task_id::text, 0));

    if p_position is null then
        select coalesce(max(position), 0) + 1
          into v_pos
          from public.task_items
         where task_id = p_task_id;
    else
        v_pos := p_position;
    end if;

    insert into public.task_items (task_id, title, description, position)
    values (p_task_id, p_title, p_description, v_pos)
    returning id into v_id;

    insert into public.audit_log
        (project_id, user_id, action, entity_type, entity_id, new_data)
    select t.project_id, v_user, 'created', 'task_item', v_id,
           jsonb_build_object('title', p_title, 'description', p_description, 'position', v_pos)
      from public.tasks t
     where t.id = p_task_id;

    return v_id;
end
$$;
