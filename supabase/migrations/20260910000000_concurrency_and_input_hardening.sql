-- TaskTrace concurrency and input hardening.
--
-- All project/task relationship mutations take locks in the same order:
-- project -> task -> item. This prevents TOCTOU races between access changes,
-- ownership changes, archiving, and checklist mutations.

create or replace function private.lock_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
begin
    perform 1 from public.projects where id = p_project_id for update;
    if not found then
        raise exception 'project not found';
    end if;
end
$$;

create or replace function private.lock_task(p_task_id uuid)
returns public.tasks
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_task public.tasks%rowtype;
begin
    select * into v_task
      from public.tasks
     where id = p_task_id
     for update;
    if not found then
        raise exception 'task not found';
    end if;
    return v_task;
end
$$;

revoke all on function private.lock_project(uuid), private.lock_task(uuid)
    from public, anon, authenticated;

-- Empty Auth metadata must fall back to a valid profile name instead of
-- violating profiles_display_name_not_blank and aborting sign-up.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = private, public
as $$
begin
    insert into public.profiles (id, display_name)
    values (
        new.id,
        coalesce(
            nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
            nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
            nullif(btrim(split_part(coalesce(new.email, 'user'), '@', 1)), ''),
            'user'
        )
    )
    on conflict (id) do nothing;
    return new;
end
$$;

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own
on public.notifications for select
to authenticated
using (user_id = (select auth.uid()));

-- Reject impossible ordering values at the database boundary.
alter table public.task_items
    drop constraint if exists task_items_position_valid;
alter table public.task_items
    add constraint task_items_position_valid
    check (position >= 0 and position <> 'NaN'::numeric);

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

    insert into public.tasks (project_id, title, description, created_by)
    values (p_project_id, p_title, p_description, v_user)
    returning id into v_id;

    insert into public.task_members (task_id, user_id, approved_by)
    values (v_id, v_user, v_user);

    insert into public.audit_log (project_id, user_id, action, entity_type, entity_id, new_data)
    values (p_project_id, v_user, 'created', 'task', v_id,
            jsonb_build_object('title', p_title, 'description', p_description));

    return v_id;
end
$$;

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
    if private.project_role_of(v_task.project_id) = 'viewer' then
        raise exception 'viewers cannot create items' using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived' or not private.project_is_active(v_task.project_id) then
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
    values (p_task_id, p_title, p_description, v_pos)
    returning id into v_id;

    insert into public.audit_log (project_id, user_id, action, entity_type, entity_id, new_data)
    values (v_task.project_id, v_user, 'created', 'task_item', v_id,
            jsonb_build_object('title', p_title, 'description', p_description, 'position', v_pos));
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

    if not private.has_task_access(r.task_id)
       or private.project_role_of(v_task.project_id) = 'viewer' then
        raise exception 'no access to task item' using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived' or not private.project_is_active(v_task.project_id) or r.is_archived then
        raise exception 'task item is archived';
    end if;
    if p_position is not null and (p_position < 0 or p_position = 'NaN'::numeric) then
        raise exception 'item position must be a non-negative finite number';
    end if;
    if p_title is not null and p_title is distinct from r.title then
        if length(btrim(p_title)) = 0 then raise exception 'item title must not be blank'; end if;
        v_old := v_old || jsonb_build_object('title', r.title);
        v_new := v_new || jsonb_build_object('title', p_title);
    end if;
    if p_description is not null and p_description is distinct from r.description then
        v_old := v_old || jsonb_build_object('description', r.description);
        v_new := v_new || jsonb_build_object('description', p_description);
    end if;
    if p_position is not null and p_position is distinct from r.position then
        v_old := v_old || jsonb_build_object('position', r.position);
        v_new := v_new || jsonb_build_object('position', p_position);
    end if;
    if v_new = '{}'::jsonb then return; end if;

    update public.task_items
       set title = coalesce(p_title, title),
           description = coalesce(p_description, description),
           position = coalesce(p_position, position)
     where id = r.id;

    v_action := case when v_old ? 'position' then 'reordered' else 'updated' end::public.audit_action;
    insert into public.audit_log (project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (v_task.project_id, v_user, v_action, 'task_item', r.id, v_old, v_new);
end
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
begin
    select task_id into v_task_id from public.task_items where id = p_task_item_id;
    if not found then raise exception 'no access to task item' using errcode = 'insufficient_privilege'; end if;
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
    if r_item.is_completed = p_completed then return p_completed; end if;

    update public.task_items set is_completed = p_completed where id = r_item.id;
    v_action := case when p_completed then 'checked' else 'unchecked' end::public.item_action_type;
    insert into public.item_actions (project_id, task_id, task_item_id, user_id, action)
    values (v_task.project_id, v_task.id, r_item.id, v_user, v_action);
    insert into public.audit_log (project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (v_task.project_id, v_user, v_action::text::public.audit_action, 'task_item', r_item.id,
            jsonb_build_object('is_completed', r_item.is_completed),
            jsonb_build_object('is_completed', p_completed));
    return p_completed;
end
$$;

-- Lock the project before every membership/assignment/archiving operation.
create or replace function public.approve_task_member(p_task_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = private, public as $$
declare
    v_user uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
    v_task public.tasks%rowtype;
begin
    perform private.lock_project(v_project_id);
    v_task := private.lock_task(p_task_id);
    if not private.is_project_admin(v_project_id) then raise exception 'only owner/admin can approve task members' using errcode='insufficient_privilege'; end if;
    if not private.project_is_active(v_project_id) then raise exception 'project is archived'; end if;
    if v_task.status = 'archived' then raise exception 'task is archived'; end if;
    if not private.is_project_member(v_project_id, p_user_id) then raise exception 'cannot grant task access to a non project member'; end if;
    if exists (select 1 from public.task_members where task_id=p_task_id and user_id=p_user_id) then return; end if;
    insert into public.task_members(task_id,user_id,approved_by) values(p_task_id,p_user_id,v_user);
    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,new_data)
    values(v_project_id,v_user,'access_approved','task_member',p_user_id,jsonb_build_object('task_id',p_task_id,'user_id',p_user_id));
end $$;

create or replace function public.revoke_task_member(p_task_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = private, public as $$
declare
    v_user uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
    v_was_assignee boolean;
begin
    perform private.lock_project(v_project_id);
    perform private.lock_task(p_task_id);
    if not private.is_project_admin(v_project_id) then raise exception 'only owner/admin can revoke task members' using errcode='insufficient_privilege'; end if;
    if not private.project_is_active(v_project_id) then raise exception 'project is archived'; end if;
    if not exists (select 1 from public.task_members where task_id=p_task_id and user_id=p_user_id) then return; end if;
    select exists(select 1 from public.task_assignees where task_id=p_task_id and user_id=p_user_id) into v_was_assignee;
    delete from public.task_assignees where task_id=p_task_id and user_id=p_user_id;
    delete from public.task_members where task_id=p_task_id and user_id=p_user_id;
    if v_was_assignee then
        insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,new_data)
        values(v_project_id,v_user,'assignee_removed','task_assignee',p_user_id,jsonb_build_object('task_id',p_task_id,'user_id',p_user_id,'reason','task access revoked'));
    end if;
    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,new_data)
    values(v_project_id,v_user,'access_revoked','task_member',p_user_id,jsonb_build_object('task_id',p_task_id,'user_id',p_user_id));
end $$;

create or replace function public.add_task_assignee(p_task_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = private, public as $$
declare
    v_user uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
    v_task public.tasks%rowtype;
begin
    perform private.lock_project(v_project_id);
    v_task := private.lock_task(p_task_id);
    if not private.is_project_admin(v_project_id) then raise exception 'only owner/admin can manage assignees' using errcode='insufficient_privilege'; end if;
    if v_task.status='archived' or not private.project_is_active(v_project_id) then raise exception 'task is archived'; end if;
    if not private.is_project_member(v_project_id,p_user_id) then raise exception 'assignee must be a project member'; end if;
    if not exists(select 1 from public.task_members where task_id=p_task_id and user_id=p_user_id) then raise exception 'assignee must have access to the task (task_members)'; end if;
    if exists(select 1 from public.task_assignees where task_id=p_task_id and user_id=p_user_id) then return; end if;
    insert into public.task_assignees(task_id,user_id,assigned_by) values(p_task_id,p_user_id,v_user);
    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,new_data)
    values(v_project_id,v_user,'assignee_added','task_assignee',p_user_id,jsonb_build_object('task_id',p_task_id,'user_id',p_user_id));
end $$;

create or replace function public.remove_task_assignee(p_task_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = private, public as $$
declare
    v_user uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
begin
    perform private.lock_project(v_project_id);
    perform private.lock_task(p_task_id);
    if not private.is_project_admin(v_project_id) then raise exception 'only owner/admin can manage assignees' using errcode='insufficient_privilege'; end if;
    if not private.project_is_active(v_project_id) then raise exception 'project is archived'; end if;
    if not exists(select 1 from public.task_assignees where task_id=p_task_id and user_id=p_user_id) then return; end if;
    delete from public.task_assignees where task_id=p_task_id and user_id=p_user_id;
    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,new_data)
    values(v_project_id,v_user,'assignee_removed','task_assignee',p_user_id,jsonb_build_object('task_id',p_task_id,'user_id',p_user_id));
end $$;

create or replace function public.add_project_member(p_project_id uuid, p_user_id uuid, p_role public.project_role)
returns void language plpgsql security definer set search_path = private, public as $$
declare v_user uuid := private.require_auth();
begin
    perform private.lock_project(p_project_id);
    if not private.is_project_admin(p_project_id) then raise exception 'only owner/admin can manage project members' using errcode='insufficient_privilege'; end if;
    if not private.project_is_active(p_project_id) then raise exception 'project is archived'; end if;
    if p_role='owner' then raise exception 'use transfer_project_ownership to set a new owner'; end if;
    if exists(select 1 from public.project_members where project_id=p_project_id and user_id=p_user_id) then raise exception 'user is already a project member'; end if;
    insert into public.project_members(project_id,user_id,role) values(p_project_id,p_user_id,p_role);
    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,new_data)
    values(p_project_id,v_user,'member_added','project_member',p_user_id,jsonb_build_object('user_id',p_user_id,'role',p_role));
end $$;

create or replace function public.remove_project_member(p_project_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = private, public as $$
declare
    v_user uuid := private.require_auth();
    v_role public.project_role;
    v_task_id uuid;
begin
    perform private.lock_project(p_project_id);
    if not private.is_project_admin(p_project_id) then raise exception 'only owner/admin can manage project members' using errcode='insufficient_privilege'; end if;
    if not private.project_is_active(p_project_id) then raise exception 'project is archived'; end if;
    select role into v_role from public.project_members where project_id=p_project_id and user_id=p_user_id;
    if not found then return; end if;
    if v_role='owner' then raise exception 'cannot remove the project owner - transfer ownership first'; end if;
    for v_task_id in select t.id from public.tasks t where t.project_id=p_project_id and (exists(select 1 from public.task_members tm where tm.task_id=t.id and tm.user_id=p_user_id) or exists(select 1 from public.task_assignees ta where ta.task_id=t.id and ta.user_id=p_user_id)) loop
        if exists(select 1 from public.task_assignees where task_id=v_task_id and user_id=p_user_id) then
            insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,new_data) values(p_project_id,v_user,'assignee_removed','task_assignee',p_user_id,jsonb_build_object('task_id',v_task_id,'user_id',p_user_id,'reason','project access removed'));
        end if;
        if exists(select 1 from public.task_members where task_id=v_task_id and user_id=p_user_id) then
            insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,new_data) values(p_project_id,v_user,'access_revoked','task_member',p_user_id,jsonb_build_object('task_id',v_task_id,'user_id',p_user_id,'reason','project access removed'));
        end if;
    end loop;
    delete from public.task_assignees a using public.tasks t where a.task_id=t.id and t.project_id=p_project_id and a.user_id=p_user_id;
    delete from public.task_members m using public.tasks t where m.task_id=t.id and t.project_id=p_project_id and m.user_id=p_user_id;
    delete from public.project_members where project_id=p_project_id and user_id=p_user_id;
    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data) values(p_project_id,v_user,'member_removed','project_member',p_user_id,jsonb_build_object('user_id',p_user_id,'role',v_role));
end $$;

create or replace function public.change_member_role(p_project_id uuid, p_user_id uuid, p_new_role public.project_role)
returns void language plpgsql security definer set search_path = private, public as $$
declare
    v_user uuid := private.require_auth();
    v_caller_role public.project_role;
    v_target_role public.project_role;
begin
    perform private.lock_project(p_project_id);
    v_caller_role := private.project_role_of(p_project_id);
    v_target_role := private.project_role_of(p_project_id,p_user_id);
    if v_caller_role not in ('owner','admin') then raise exception 'only owner/admin can change roles' using errcode='insufficient_privilege'; end if;
    if v_target_role is null then raise exception 'target user is not a project member'; end if;
    if v_target_role='owner' then raise exception 'the owner role can only be changed via transfer_project_ownership'; end if;
    if p_new_role='owner' then raise exception 'use transfer_project_ownership to set a new owner'; end if;
    if v_caller_role='admin' and v_target_role='admin' and p_user_id<>v_user then raise exception 'admin cannot change the role of another admin' using errcode='insufficient_privilege'; end if;
    if not private.project_is_active(p_project_id) then raise exception 'project is archived'; end if;
    update public.project_members set role=p_new_role where project_id=p_project_id and user_id=p_user_id;
    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data,new_data)
    values(p_project_id,v_user,'role_changed','project_member',p_user_id,jsonb_build_object('user_id',p_user_id,'role',v_target_role),jsonb_build_object('user_id',p_user_id,'role',p_new_role));
end $$;

create or replace function public.transfer_project_ownership(p_project_id uuid, p_new_owner_id uuid)
returns void language plpgsql security definer set search_path = private, public as $$
declare
    v_user uuid := private.require_auth();
    v_new_role public.project_role;
begin
    perform private.lock_project(p_project_id);
    if not private.is_project_owner(p_project_id) then raise exception 'only the current owner can transfer ownership' using errcode='insufficient_privilege'; end if;
    if p_new_owner_id=v_user then raise exception 'cannot transfer ownership to yourself'; end if;
    v_new_role := private.project_role_of(p_project_id,p_new_owner_id);
    if v_new_role is null then raise exception 'new owner must be a project member'; end if;
    if not private.project_is_active(p_project_id) then raise exception 'project is archived'; end if;
    update public.project_members set role='admin' where project_id=p_project_id and user_id=v_user;
    update public.project_members set role='owner' where project_id=p_project_id and user_id=p_new_owner_id;
    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data,new_data)
    values(p_project_id,v_user,'role_changed','project_member',v_user,jsonb_build_object('user_id',v_user,'role','owner'),jsonb_build_object('user_id',v_user,'role','admin')),
          (p_project_id,v_user,'role_changed','project_member',p_new_owner_id,jsonb_build_object('user_id',p_new_owner_id,'role',v_new_role),jsonb_build_object('user_id',p_new_owner_id,'role','owner'));
end $$;

create or replace function public.archive_project(p_project_id uuid)
returns void language plpgsql security definer set search_path = private, public as $$
begin
    perform private.require_auth();
    perform private.lock_project(p_project_id);
    if not private.is_project_admin(p_project_id) then raise exception 'only owner/admin can archive the project' using errcode='insufficient_privilege'; end if;
    update public.projects set status='archived', archived_at=now() where id=p_project_id and status='active';
end $$;

create or replace function public.archive_task(p_task_id uuid)
returns void language plpgsql security definer set search_path = private, public as $$
declare
    v_project_id uuid := private.task_project_id(p_task_id);
begin
    perform private.require_auth();
    perform private.lock_project(v_project_id);
    perform private.lock_task(p_task_id);
    if not private.is_project_admin(v_project_id) then raise exception 'only owner/admin can archive tasks' using errcode='insufficient_privilege'; end if;
    if not private.project_is_active(v_project_id) then raise exception 'project is archived'; end if;
    update public.tasks set status='archived', archived_at=now() where id=p_task_id and status<>'archived';
end $$;

create or replace function public.archive_task_item(p_task_item_id uuid)
returns void language plpgsql security definer set search_path = private, public as $$
declare
    v_user uuid := private.require_auth();
    v_task_id uuid;
    v_project_id uuid;
    v_task public.tasks%rowtype;
    r public.task_items%rowtype;
begin
    select task_id into v_task_id from public.task_items where id=p_task_item_id;
    if not found then raise exception 'task item not found'; end if;
    v_project_id := private.task_project_id(v_task_id);
    perform private.lock_project(v_project_id);
    v_task := private.lock_task(v_task_id);
    select * into r from public.task_items where id=p_task_item_id for update;
    if not private.is_project_admin(v_project_id) then raise exception 'only owner/admin can archive task items' using errcode='insufficient_privilege'; end if;
    if v_task.status='archived' or not private.project_is_active(v_project_id) then raise exception 'task is archived'; end if;
    if r.is_archived then return; end if;
    update public.task_items set is_archived=true, archived_at=now() where id=r.id;
    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data,new_data)
    values(v_project_id,v_user,'archived','task_item',r.id,jsonb_build_object('is_archived',false),jsonb_build_object('is_archived',true));
end $$;
