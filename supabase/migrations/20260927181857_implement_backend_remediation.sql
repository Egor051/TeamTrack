-- Backend security/correctness remediation.
--
-- This migration intentionally leaves the historical archived-template cleanup
-- unchanged and does not add an auth.users deletion lifecycle: both are product
-- decisions. Everything below is forward-only.

-- Retire ambiguous or misleading legacy entry points before changing their
-- backing schema.
drop function if exists public.update_task_item(uuid, text, text, numeric, text);
drop function if exists public.approve_task_member(uuid, uuid);
drop function if exists public.revoke_task_member(uuid, uuid);
drop function if exists public.audit_to_notification();

-- Task-level rows now have one meaning: a nullable explicit checklist role
-- override. Every project-member/task pair has a row so a concurrent override
-- is always an UPDATE that post-lock authorization can observe.
alter table public.task_members
    rename column approved_by to set_by;

alter table public.task_members
    rename column approved_at to set_at;

alter table public.task_members
    add column role_override public.project_role;

alter table public.task_members
    drop constraint if exists task_members_approved_by_fkey;

alter table public.task_members
    add constraint task_members_set_by_fkey
    foreign key (set_by) references auth.users(id) on delete restrict;

alter table public.task_members
    add constraint task_members_role_override_chk
    check (role_override is null or role_override <> 'owner'::public.project_role);

comment on table public.task_members is
    'Per-stage checklist role state. A null role_override inherits project_members.role.';
comment on column public.task_members.role_override is
    'Optional checklist-only override. It never grants project-level authority.';
comment on column public.task_members.set_by is
    'Project owner/admin who most recently set this override.';
comment on column public.task_members.set_at is
    'Time at which the inheritance/override state was most recently written.';

insert into public.task_members(task_id, user_id, set_by, set_at, role_override)
select t.id, pm.user_id, t.created_by, now(), null
  from public.tasks t
  join public.project_members pm on pm.project_id = t.project_id
on conflict (task_id, user_id) do nothing;

create index if not exists task_members_user_id_idx
    on public.task_members(user_id);
create index if not exists task_templates_created_by_idx
    on public.task_templates(created_by);

-- One set of text limits is enforced by storage and every public mutation RPC.
-- The preceding schema allowed shorter/longer or differently formatted text.
-- Preserve those existing rows on upgrade; NOT VALID enforces the new rule on
-- every subsequent INSERT/UPDATE without rewriting user data or history.
alter table public.profiles
    drop constraint if exists profiles_display_name_not_blank;
alter table public.profiles
    add constraint profiles_display_name_valid
    check (
        char_length(btrim(display_name)) between 2 and 80
        and btrim(display_name) ~ '^[[:alnum:]_ .-]+$'
    ) not valid;

alter table public.projects
    add constraint projects_name_length_chk
    check (char_length(btrim(name)) between 1 and 500) not valid;
alter table public.projects
    add constraint projects_description_length_chk
    check (description is null or char_length(description) <= 10000) not valid;

alter table public.tasks
    add constraint tasks_title_length_chk
    check (char_length(btrim(title)) between 1 and 500) not valid;
alter table public.tasks
    add constraint tasks_description_length_chk
    check (description is null or char_length(description) <= 10000) not valid;

alter table public.task_items
    add constraint task_items_title_length_chk
    check (char_length(btrim(title)) between 1 and 500) not valid;
alter table public.task_items
    add constraint task_items_description_length_chk
    check (description is null or char_length(description) <= 10000) not valid;
alter table public.task_items
    drop constraint if exists task_items_comment_length_chk;
alter table public.task_items
    add constraint task_items_comment_length_chk
    check (comment is null or char_length(comment) <= 10000) not valid;

alter table public.task_templates
    drop constraint if exists task_templates_name_chk;
alter table public.task_templates
    add constraint task_templates_name_chk
    check (char_length(btrim(name)) between 1 and 500) not valid;

-- Canonical effective checklist role: explicit override first, inherited
-- project role otherwise. No override can create project-level authority.
create or replace function private.task_role_of(
    p_task_id uuid,
    p_user_id uuid default auth.uid()
)
returns public.project_role
language sql
stable
security definer
set search_path = private, public
as $$
    select coalesce(tm.role_override, pm.role)
      from public.tasks t
      join public.project_members pm
        on pm.project_id = t.project_id
       and pm.user_id = p_user_id
      left join public.task_members tm
        on tm.task_id = t.id
       and tm.user_id = p_user_id
     where t.id = p_task_id;
$$;

create or replace function private.has_task_access(
    p_task_id uuid,
    p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = private, public
as $$
    select private.task_role_of(p_task_id, p_user_id) is not null;
$$;

create or replace function private.can_edit_task(
    p_task_id uuid,
    p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = private, public
as $$
    select private.task_role_of(p_task_id, p_user_id) in ('owner', 'admin', 'member');
$$;

create or replace function private.can_manage_task_checklist(
    p_task_id uuid,
    p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = private, public
as $$
    select private.task_role_of(p_task_id, p_user_id) in ('owner', 'admin');
$$;

create or replace function private.lock_project_state(p_project_id uuid)
returns public.projects
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_project public.projects%rowtype;
begin
    select * into v_project
      from public.projects
     where id = p_project_id
     for update;
    if not found then raise exception 'project not found'; end if;
    return v_project;
end;
$$;

create or replace function private.lock_project_role(p_project_id uuid, p_user_id uuid)
returns public.project_role
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_role public.project_role;
begin
    select role into v_role
      from public.project_members
     where project_id = p_project_id and user_id = p_user_id
     for update;
    return v_role;
end;
$$;

create or replace function private.lock_task_role(p_task_id uuid, p_project_id uuid, p_user_id uuid)
returns public.project_role
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_project_role public.project_role;
    v_override public.project_role;
begin
    v_project_role := private.lock_project_role(p_project_id, p_user_id);
    if v_project_role is null then return null; end if;

    select role_override into v_override
      from public.task_members
     where task_id = p_task_id and user_id = p_user_id
     for update;
    return coalesce(v_override, v_project_role);
end;
$$;

comment on function private.task_role_of(uuid, uuid) is
    'Returns the checklist-only override when present, otherwise the inherited project role.';
comment on function private.can_manage_task_checklist(uuid, uuid) is
    'True for effective owner/admin checklist roles; does not imply project-level authority.';

revoke all on function private.task_role_of(uuid, uuid) from public, anon, service_role;
revoke all on function private.has_task_access(uuid, uuid) from public, anon, service_role;
revoke all on function private.can_edit_task(uuid, uuid) from public, anon, service_role;
revoke all on function private.can_manage_task_checklist(uuid, uuid) from public, anon, service_role;
revoke all on function private.lock_project_state(uuid) from public, anon, authenticated, service_role;
revoke all on function private.lock_project_role(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.lock_task_role(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- RLS-facing wrappers never accept an arbitrary subject. Internal RPCs retain
-- the two-argument helpers, but authenticated clients cannot execute those
-- helpers directly as a cross-tenant membership oracle.
create or replace function private.current_is_project_member(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = private, public
as $$
    select private.is_project_member(p_project_id, auth.uid())
$$;

create or replace function private.current_is_project_admin(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = private, public
as $$
    select private.is_project_admin(p_project_id, auth.uid())
$$;

create or replace function private.current_has_task_access(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = private, public
as $$
    select private.has_task_access(p_task_id, auth.uid())
$$;

create or replace function private.current_is_task_project_admin(p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = private, public
as $$
    select private.is_task_project_admin(p_task_id, auth.uid())
$$;

drop policy if exists project_members_select_project_member on public.project_members;
create policy project_members_select_project_member on public.project_members
for select to authenticated using (private.current_is_project_member(project_id));

drop policy if exists projects_select_member on public.projects;
create policy projects_select_member on public.projects
for select to authenticated using (private.current_is_project_member(id));

drop policy if exists tasks_select_project_member on public.tasks;
create policy tasks_select_project_member on public.tasks
for select to authenticated using (private.current_is_project_member(project_id));

drop policy if exists task_items_select_task_member on public.task_items;
create policy task_items_select_task_member on public.task_items
for select to authenticated using (private.current_has_task_access(task_id));

drop policy if exists item_actions_select_task_member on public.item_actions;
create policy item_actions_select_task_member on public.item_actions
for select to authenticated using (private.current_has_task_access(task_id));

drop policy if exists task_assignees_select_task_member on public.task_assignees;
create policy task_assignees_select_task_member on public.task_assignees
for select to authenticated using (private.current_has_task_access(task_id));

drop policy if exists task_members_select_task_member_or_admin on public.task_members;
create policy task_members_select_task_member_or_admin on public.task_members
for select to authenticated using (
    user_id = auth.uid() or private.current_is_task_project_admin(task_id)
);

-- Application writes are RPC-only; stale direct-update policies add no value
-- when authenticated has no UPDATE table grant.
drop policy if exists projects_update_admin on public.projects;
drop policy if exists tasks_update_editable on public.tasks;

-- Audit visibility is explicit for each non-project entity. Project owner/admin
-- can inspect all project audit rows; a user's profile history remains private.
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
    v_template_id uuid;
begin
    if p_entity_type = 'profile' then
        return p_entity_id = auth.uid();
    end if;

    if p_entity_type = 'task_template' then
        return exists (
            select 1
              from public.task_templates tt
             where tt.id = p_entity_id
               and tt.created_by = auth.uid()
        ) or coalesce(p_new_data->>'created_by', p_old_data->>'created_by') = auth.uid()::text;
    end if;

    if p_entity_type = 'task_template_item' then
        select tti.template_id
          into v_template_id
          from public.task_template_items tti
         where tti.id = p_entity_id;
        if v_template_id is null then
            begin
                v_template_id := nullif(coalesce(p_new_data->>'template_id', p_old_data->>'template_id'), '')::uuid;
            exception when invalid_text_representation then
                return false;
            end;
        end if;
        return exists (
            select 1
              from public.task_templates tt
             where tt.id = v_template_id
               and tt.created_by = auth.uid()
        );
    end if;

    if p_project_id is not null and private.is_project_admin(p_project_id) then
        return true;
    end if;

    if p_entity_type in ('project', 'project_member') then
        return p_project_id is not null and private.is_project_member(p_project_id);
    end if;

    if p_entity_type in ('task', 'task_from_template') then
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
end;
$$;

revoke all on function private.audit_log_visible(uuid, text, uuid, jsonb, jsonb)
    from public, anon, service_role;
grant execute on function private.audit_log_visible(uuid, text, uuid, jsonb, jsonb)
    to authenticated;

-- public.profiles is canonical. Auth metadata is only an initial provisioning
-- input and can never overwrite a profile later.
drop trigger if exists on_auth_user_updated on auth.users;
drop function if exists private.handle_auth_user_update();

create or replace function private.profile_name_is_valid(p_value text)
returns boolean
language sql
immutable
set search_path = ''
as $$
    select p_value is not null
       and char_length(btrim(p_value)) between 2 and 80
       and btrim(p_value) ~ '^[[:alnum:]_ .-]+$';
$$;

create or replace function private.initial_profile_name(
    p_user_id uuid,
    p_metadata jsonb,
    p_email text
)
returns text
language plpgsql
immutable
set search_path = private
as $$
declare
    v_candidate text;
begin
    foreach v_candidate in array array[
        nullif(btrim(p_metadata->>'display_name'), ''),
        nullif(btrim(p_metadata->>'name'), ''),
        nullif(btrim(split_part(coalesce(p_email, ''), '@', 1)), '')
    ] loop
        if private.profile_name_is_valid(v_candidate) then
            return btrim(v_candidate);
        end if;
    end loop;
    return 'user-' || left(p_user_id::text, 8);
end;
$$;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = private, public
as $$
begin
    insert into public.profiles(id, display_name)
    values (
        new.id,
        private.initial_profile_name(new.id, coalesce(new.raw_user_meta_data, '{}'::jsonb), new.email)
    )
    on conflict (id) do nothing;
    return new;
end;
$$;

create or replace function private.ensure_profile(p_user_id uuid)
returns public.profiles
language plpgsql
security definer
set search_path = private, public, auth
as $$
declare
    v_profile public.profiles%rowtype;
    v_user auth.users%rowtype;
begin
    select * into v_profile from public.profiles where id = p_user_id;
    if found then
        return v_profile;
    end if;

    select * into v_user from auth.users where id = p_user_id;
    if not found then
        raise exception 'auth user not found' using errcode = 'insufficient_privilege';
    end if;

    insert into public.profiles(id, display_name)
    values (
        v_user.id,
        private.initial_profile_name(v_user.id, coalesce(v_user.raw_user_meta_data, '{}'::jsonb), v_user.email)
    )
    on conflict (id) do nothing;

    select * into v_profile from public.profiles where id = p_user_id;
    return v_profile;
end;
$$;

create or replace function public.get_my_profile()
returns public.profiles
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
begin
    perform pg_advisory_xact_lock(hashtextextended('profile:' || v_user::text, 0));
    return private.ensure_profile(v_user);
end;
$$;

create or replace function public.update_my_profile(p_display_name text)
returns public.profiles
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_name text := btrim(coalesce(p_display_name, ''));
    v_old public.profiles%rowtype;
    v_profile public.profiles%rowtype;
begin
    if not private.profile_name_is_valid(v_name) then
        raise exception 'display name must contain 2..80 supported characters';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('profile:' || v_user::text, 0));
    v_old := private.ensure_profile(v_user);
    if v_old.display_name = v_name then
        return v_old;
    end if;

    update public.profiles
       set display_name = v_name
     where id = v_user
     returning * into v_profile;

    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        null,
        v_user,
        'updated',
        'profile',
        v_user,
        jsonb_build_object('display_name', v_old.display_name),
        jsonb_build_object('display_name', v_profile.display_name)
    );
    return v_profile;
end;
$$;

drop policy if exists profiles_update_self on public.profiles;
revoke update on table public.profiles from authenticated, anon, service_role;
revoke update(display_name, avatar_url) on public.profiles from authenticated, anon, service_role;

revoke all on function private.profile_name_is_valid(text) from public, anon, authenticated, service_role;
revoke all on function private.initial_profile_name(uuid, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function private.ensure_profile(uuid) from public, anon, authenticated, service_role;
revoke all on function private.handle_new_user() from public, anon, authenticated, service_role;
revoke all on function public.get_my_profile() from public, anon, service_role;
revoke all on function public.update_my_profile(text) from public, anon, service_role;
grant execute on function public.get_my_profile() to authenticated;
grant execute on function public.update_my_profile(text) to authenticated;

-- Explicit checklist override API. Project-level roles remain the authority
-- for creating/clearing overrides; the override itself is never consulted for
-- project membership administration.
create or replace function public.get_my_task_role(p_task_id uuid)
returns public.project_role
language plpgsql
stable
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_role public.project_role;
begin
    v_role := private.task_role_of(p_task_id, v_user);
    if v_role is null then
        raise exception 'no access to task' using errcode = 'insufficient_privilege';
    end if;
    return v_role;
end;
$$;

create or replace function public.list_task_member_overrides(p_task_id uuid)
returns table (
    user_id uuid,
    role_override public.project_role,
    set_by uuid,
    set_at timestamptz
)
language plpgsql
stable
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
    v_role public.project_role;
begin
    v_role := private.project_role_of(v_project_id, v_user);
    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can view checklist overrides'
            using errcode = 'insufficient_privilege';
    end if;
    return query
    select tm.user_id, tm.role_override, tm.set_by, tm.set_at
      from public.task_members tm
     where tm.task_id = p_task_id
       and tm.role_override is not null
     order by tm.user_id;
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

revoke all on function public.get_my_task_role(uuid) from public, anon, service_role;
revoke all on function public.list_task_member_overrides(uuid) from public, anon, service_role;
revoke all on function public.set_task_member_override(uuid, uuid, public.project_role) from public, anon, service_role;
revoke all on function public.clear_task_member_override(uuid, uuid) from public, anon, service_role;
grant execute on function public.get_my_task_role(uuid) to authenticated;
grant execute on function public.list_task_member_overrides(uuid) to authenticated;
grant execute on function public.set_task_member_override(uuid, uuid, public.project_role) to authenticated;
grant execute on function public.clear_task_member_override(uuid, uuid) to authenticated;

create or replace function public.add_project_member(
    p_project_id uuid,
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
    v_project public.projects%rowtype;
    v_actor_role public.project_role;
begin
    v_project := private.lock_project_state(p_project_id);
    v_actor_role := private.lock_project_role(p_project_id, v_actor);
    if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can manage project members'
            using errcode = 'insufficient_privilege';
    end if;
    if p_role = 'owner' then
        raise exception 'use transfer_project_ownership to set a new owner';
    end if;
    if p_role = 'admin' and v_actor_role <> 'owner' then
        raise exception 'only the owner can add an admin'
            using errcode = 'insufficient_privilege';
    end if;
    if v_project.status <> 'active' then
        raise exception 'project is archived';
    end if;
    if not exists (select 1 from auth.users where id = p_user_id) then
        raise exception 'user not found';
    end if;
    if exists (
        select 1 from public.project_members
         where project_id = p_project_id and user_id = p_user_id
    ) then
        raise exception 'user is already a project member';
    end if;

    insert into public.project_members(project_id, user_id, role)
    values (p_project_id, p_user_id, p_role);
    insert into public.task_members(task_id, user_id, set_by, set_at, role_override)
    select t.id, p_user_id, v_actor, now(), null
      from public.tasks t
     where t.project_id = p_project_id
    on conflict (task_id, user_id) do nothing;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, new_data)
    values (
        p_project_id,
        v_actor,
        'member_added',
        'project_member',
        p_user_id,
        jsonb_build_object('user_id', p_user_id, 'role', p_role)
    );
end;
$$;

create or replace function public.add_project_member_by_identifier(
    p_project_id uuid,
    p_identifier text,
    p_role public.project_role
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
    v_identifier text := btrim(coalesce(p_identifier, ''));
    v_target uuid;
    v_count integer;
begin
    v_project := private.lock_project_state(p_project_id);
    v_actor_role := private.lock_project_role(p_project_id, v_actor);
    if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can manage project members'
            using errcode = 'insufficient_privilege';
    end if;
    if p_role = 'owner' then
        raise exception 'use transfer_project_ownership to set a new owner';
    end if;
    if p_role = 'admin' and v_actor_role <> 'owner' then
        raise exception 'only the owner can add an admin'
            using errcode = 'insufficient_privilege';
    end if;
    if v_project.status <> 'active' then
        raise exception 'project is archived';
    end if;
    if v_identifier = '' then
        raise exception 'identifier is required';
    end if;

    select count(*), (array_agg(id order by id))[1]
      into v_count, v_target
      from auth.users
     where email = lower(v_identifier);

    if v_count = 0 then
        select count(*), (array_agg(id order by id))[1]
          into v_count, v_target
          from public.profiles
         where display_name = v_identifier;
        if v_count > 1 then
            raise exception 'display name is ambiguous';
        end if;
    elsif v_count > 1 then
        raise exception 'email is ambiguous';
    end if;

    if v_count = 0 or v_target is null then
        raise exception 'user not found';
    end if;
    if exists (
        select 1 from public.project_members
         where project_id = p_project_id and user_id = v_target
    ) then
        raise exception 'user is already a project member';
    end if;

    insert into public.project_members(project_id, user_id, role)
    values (p_project_id, v_target, p_role);
    insert into public.task_members(task_id, user_id, set_by, set_at, role_override)
    select t.id, v_target, v_actor, now(), null
      from public.tasks t
     where t.project_id = p_project_id
    on conflict (task_id, user_id) do nothing;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, new_data)
    values (
        p_project_id,
        v_actor,
        'member_added',
        'project_member',
        v_target,
        jsonb_build_object('user_id', v_target, 'role', p_role)
    );
end;
$$;

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

create or replace function public.remove_project_member(
    p_project_id uuid,
    p_user_id uuid
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
    v_project := private.lock_project_state(p_project_id);
    v_actor_role := private.lock_project_role(p_project_id, v_actor);
    v_target_role := private.lock_project_role(p_project_id, p_user_id);
    if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can manage project members'
            using errcode = 'insufficient_privilege';
    end if;
    if v_project.status <> 'active' then
        raise exception 'project is archived';
    end if;
    if v_target_role is null then
        return;
    end if;
    if v_target_role = 'owner' then
        raise exception 'cannot remove the project owner - transfer ownership first';
    end if;
    if v_target_role = 'admin' and v_actor_role <> 'owner' then
        raise exception 'only the owner can remove an administrator'
            using errcode = 'insufficient_privilege';
    end if;

    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, new_data)
    select p_project_id,
           v_actor,
           'assignee_removed'::public.audit_action,
           'task_assignee',
           ta.user_id,
           jsonb_build_object(
               'task_id', ta.task_id,
               'user_id', ta.user_id,
               'reason', 'project membership removed'
           )
      from public.task_assignees ta
      join public.tasks t on t.id = ta.task_id
     where t.project_id = p_project_id
       and ta.user_id = p_user_id;

    delete from public.task_assignees ta
     using public.tasks t
     where ta.task_id = t.id
       and t.project_id = p_project_id
       and ta.user_id = p_user_id;
    delete from public.task_members tm
     using public.tasks t
     where tm.task_id = t.id
       and t.project_id = p_project_id
       and tm.user_id = p_user_id;
    delete from public.project_members
     where project_id = p_project_id and user_id = p_user_id;

    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data)
    values (
        p_project_id,
        v_actor,
        'member_removed',
        'project_member',
        p_user_id,
        jsonb_build_object('user_id', p_user_id, 'role', v_target_role)
    );
end;
$$;

-- Canonical project/stage mutations. Generic UPDATE audit triggers are removed
-- below; each business RPC emits exactly one semantic event for its entity.
create or replace function public.create_project(
    p_name text,
    p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_name text := btrim(coalesce(p_name, ''));
    v_description text := nullif(btrim(coalesce(p_description, '')), '');
    v_id uuid;
begin
    if char_length(v_name) not between 1 and 500 then
        raise exception 'project name must contain 1..500 characters';
    end if;
    if v_description is not null and char_length(v_description) > 10000 then
        raise exception 'project description is too long';
    end if;

    insert into public.projects(name, description, created_by)
    values (v_name, v_description, v_user)
    returning id into v_id;
    insert into public.project_members(project_id, user_id, role)
    values (v_id, v_user, 'owner');
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, new_data)
    values (
        v_id,
        v_user,
        'created',
        'project',
        v_id,
        jsonb_build_object('name', v_name, 'description', v_description)
    );
    return v_id;
end;
$$;

create or replace function public.update_project(
    p_project_id uuid,
    p_name text,
    p_description text
)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project public.projects%rowtype;
    v_role public.project_role;
    v_name text := btrim(coalesce(p_name, ''));
    v_description text := nullif(btrim(coalesce(p_description, '')), '');
begin
    v_project := private.lock_project_state(p_project_id);
    v_role := private.lock_project_role(p_project_id, v_user);
    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'project admin role required' using errcode = 'insufficient_privilege';
    end if;
    if v_project.status <> 'active' then
        raise exception 'project must be active';
    end if;
    if char_length(v_name) not between 1 and 500 then
        raise exception 'project name must contain 1..500 characters';
    end if;
    if v_description is not null and char_length(v_description) > 10000 then
        raise exception 'project description is too long';
    end if;
    if v_name is not distinct from v_project.name
       and v_description is not distinct from v_project.description then
        return;
    end if;

    update public.projects
       set name = v_name, description = v_description
     where id = p_project_id;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        p_project_id,
        v_user,
        'updated',
        'project',
        p_project_id,
        jsonb_build_object('name', v_project.name, 'description', v_project.description),
        jsonb_build_object('name', v_name, 'description', v_description)
    );
end;
$$;

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
    v_project public.projects%rowtype;
    v_role public.project_role;
    v_title text := btrim(coalesce(p_title, ''));
    v_description text := nullif(btrim(coalesce(p_description, '')), '');
    v_id uuid;
    v_position numeric;
begin
    v_project := private.lock_project_state(p_project_id);
    v_role := private.lock_project_role(p_project_id, v_user);
    if v_role is null then
        raise exception 'not a project member' using errcode = 'insufficient_privilege';
    end if;
    if v_role = 'viewer' then
        raise exception 'viewers cannot create tasks' using errcode = 'insufficient_privilege';
    end if;
    if v_project.status <> 'active' then
        raise exception 'project is archived';
    end if;
    if char_length(v_title) not between 1 and 500 then
        raise exception 'task title must contain 1..500 characters';
    end if;
    if v_description is not null and char_length(v_description) > 10000 then
        raise exception 'task description is too long';
    end if;

    select coalesce(max(position), 0) + 1
      into v_position
      from public.tasks
     where project_id = p_project_id;

    insert into public.tasks(project_id, title, description, created_by, position)
    values (p_project_id, v_title, v_description, v_user, v_position)
    returning id into v_id;
    insert into public.task_members(task_id, user_id, set_by, set_at, role_override)
    select v_id, pm.user_id, v_user, now(), null
      from public.project_members pm
     where pm.project_id = p_project_id
    on conflict (task_id, user_id) do nothing;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, new_data)
    values (
        p_project_id,
        v_user,
        'created',
        'task',
        v_id,
        jsonb_build_object('title', v_title, 'description', v_description, 'position', v_position)
    );
    return v_id;
end;
$$;

create or replace function public.update_task(
    p_task_id uuid,
    p_title text default null,
    p_description text default null
)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_role public.project_role;
    v_title text;
    v_description text;
begin
    if v_project_id is null then
        raise exception 'task not found';
    end if;
    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(p_task_id);
    v_role := private.lock_project_role(v_project_id, v_user);
    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can edit stage details'
            using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived' or v_project.status <> 'active' then
        raise exception 'task is archived';
    end if;

    v_title := case when p_title is null then v_task.title else btrim(p_title) end;
    v_description := case
        when p_description is null then v_task.description
        else nullif(btrim(p_description), '')
    end;
    if char_length(v_title) not between 1 and 500 then
        raise exception 'task title must contain 1..500 characters';
    end if;
    if v_description is not null and char_length(v_description) > 10000 then
        raise exception 'task description is too long';
    end if;
    if v_title is not distinct from v_task.title
       and v_description is not distinct from v_task.description then
        return;
    end if;

    update public.tasks
       set title = v_title, description = v_description
     where id = p_task_id;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_project_id,
        v_user,
        'updated',
        'task',
        p_task_id,
        jsonb_build_object('title', v_task.title, 'description', v_task.description),
        jsonb_build_object('title', v_title, 'description', v_description)
    );
end;
$$;

create or replace function public.archive_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project public.projects%rowtype;
    v_role public.project_role;
    v_archive_at timestamptz := now();
begin
    v_project := private.lock_project_state(p_project_id);
    v_role := private.lock_project_role(p_project_id, v_user);
    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can archive the project'
            using errcode = 'insufficient_privilege';
    end if;
    if v_project.status <> 'active' then
        return;
    end if;

    update public.tasks
       set status = 'archived',
           archived_at = v_archive_at,
           archived_by_project_at = v_archive_at
     where project_id = p_project_id and status <> 'archived';
    update public.projects
       set status = 'archived', archived_at = v_archive_at
     where id = p_project_id;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        p_project_id,
        v_user,
        'archived',
        'project',
        p_project_id,
        jsonb_build_object('status', v_project.status, 'archived_at', v_project.archived_at),
        jsonb_build_object('status', 'archived', 'archived_at', v_archive_at)
    );
end;
$$;

create or replace function public.restore_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project public.projects%rowtype;
    v_role public.project_role;
begin
    v_project := private.lock_project_state(p_project_id);
    v_role := private.lock_project_role(p_project_id, v_user);
    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'project admin role required' using errcode = 'insufficient_privilege';
    end if;
    if v_project.status <> 'archived' then
        raise exception 'project is not archived';
    end if;

    update public.projects set status = 'active', archived_at = null where id = p_project_id;
    update public.tasks t
       set status = private.task_status_from_items(t.id),
           archived_at = null,
           archived_by_project_at = null
     where t.project_id = p_project_id
       and t.status = 'archived'
       and t.archived_by_project_at = v_project.archived_at;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        p_project_id,
        v_user,
        'restored',
        'project',
        p_project_id,
        jsonb_build_object('status', v_project.status, 'archived_at', v_project.archived_at),
        jsonb_build_object('status', 'active', 'archived_at', null)
    );
end;
$$;

create or replace function public.archive_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_role public.project_role;
    v_archived_at timestamptz := now();
begin
    if v_project_id is null then raise exception 'task not found'; end if;
    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(p_task_id);
    v_role := private.lock_project_role(v_project_id, v_user);
    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can archive tasks'
            using errcode = 'insufficient_privilege';
    end if;
    if v_project.status <> 'active' then
        raise exception 'project is archived';
    end if;
    if v_task.status = 'archived' then return; end if;

    update public.tasks
       set status = 'archived', archived_at = v_archived_at, archived_by_project_at = null
     where id = p_task_id;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_project_id,
        v_user,
        'archived',
        'task',
        p_task_id,
        jsonb_build_object('status', v_task.status, 'archived_at', v_task.archived_at),
        jsonb_build_object('status', 'archived', 'archived_at', v_archived_at)
    );
end;
$$;

create or replace function public.restore_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_role public.project_role;
    v_status public.task_status;
begin
    if v_project_id is null then raise exception 'task not found'; end if;
    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(p_task_id);
    v_role := private.lock_project_role(v_project_id, v_user);
    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can restore tasks'
            using errcode = 'insufficient_privilege';
    end if;
    if v_project.status <> 'active' then
        raise exception 'project is archived';
    end if;
    if v_task.status <> 'archived' then return; end if;

    v_status := private.task_status_from_items(p_task_id);
    update public.tasks
       set status = v_status, archived_at = null, archived_by_project_at = null
     where id = p_task_id;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_project_id,
        v_user,
        'restored',
        'task',
        p_task_id,
        jsonb_build_object('status', v_task.status, 'archived_at', v_task.archived_at),
        jsonb_build_object('status', v_status, 'archived_at', null)
    );
end;
$$;

create or replace function public.hard_delete_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_role public.project_role;
begin
    if v_project_id is null then raise exception 'task not found'; end if;
    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(p_task_id);
    v_role := private.lock_project_role(v_project_id, v_user);
    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can hard delete tasks'
            using errcode = 'insufficient_privilege';
    end if;
    if v_task.status <> 'archived' then
        raise exception 'only archived tasks can be hard deleted';
    end if;
    if v_project.status <> 'active' then
        raise exception 'project is archived';
    end if;

    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data)
    values (
        v_project_id,
        v_user,
        'removed',
        'task',
        p_task_id,
        jsonb_build_object(
            'project_id', v_project_id,
            'title', v_task.title,
            'archived_at', v_task.archived_at
        )
    );
    delete from public.tasks where id = p_task_id;
end;
$$;

-- Existing mutation entry points are brought under the same current-row lock
-- discipline. A project row serializes every mutation in that project; role
-- and state rows are then read with FOR UPDATE so READ COMMITTED cannot reuse
-- authorization from the RPC statement's pre-wait snapshot.
create or replace function public.hard_delete_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project public.projects%rowtype;
    v_role public.project_role;
begin
    v_project := private.lock_project_state(p_project_id);
    v_role := private.lock_project_role(p_project_id, v_user);
    if v_role is distinct from 'owner'::public.project_role then
        raise exception 'only the owner can hard delete a project'
            using errcode = 'insufficient_privilege';
    end if;
    if v_project.status <> 'archived' then
        raise exception 'only archived projects can be hard deleted';
    end if;

    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data)
    values (
        v_project.id,
        v_user,
        'removed',
        'project',
        v_project.id,
        jsonb_build_object(
            'project_id', v_project.id,
            'name', v_project.name,
            'archived_at', v_project.archived_at
        )
    );
    delete from public.projects where id = v_project.id;
end;
$$;

create or replace function public.move_task(p_task_id uuid, p_direction integer)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
    v_project public.projects%rowtype;
    v_role public.project_role;
    v_task public.tasks%rowtype;
    v_neighbor public.tasks%rowtype;
begin
    if p_direction not in (-1, 1) then
        raise exception 'direction must be -1 or 1';
    end if;
    if v_project_id is null then raise exception 'task not found'; end if;

    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(p_task_id);
    v_role := private.lock_project_role(v_project_id, v_user);
    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can reorder stages'
            using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived' or v_project.status <> 'active' then
        raise exception 'task is archived';
    end if;

    if p_direction = -1 then
        select * into v_neighbor
          from public.tasks t
         where t.project_id = v_project_id
           and t.status <> 'archived'
           and (t.position, t.created_at, t.id) < (v_task.position, v_task.created_at, v_task.id)
         order by t.position desc, t.created_at desc, t.id desc
         limit 1
         for update;
    else
        select * into v_neighbor
          from public.tasks t
         where t.project_id = v_project_id
           and t.status <> 'archived'
           and (t.position, t.created_at, t.id) > (v_task.position, v_task.created_at, v_task.id)
         order by t.position asc, t.created_at asc, t.id asc
         limit 1
         for update;
    end if;
    if not found then return; end if;

    update public.tasks
       set position = case
           when id = v_task.id then v_neighbor.position
           when id = v_neighbor.id then v_task.position
           else position
       end
     where id in (v_task.id, v_neighbor.id);
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values
        (v_project_id, v_user, 'reordered', 'task', v_task.id,
         jsonb_build_object('position', v_task.position),
         jsonb_build_object('position', v_neighbor.position)),
        (v_project_id, v_user, 'reordered', 'task', v_neighbor.id,
         jsonb_build_object('position', v_neighbor.position),
         jsonb_build_object('position', v_task.position));
end;
$$;

create or replace function public.transfer_project_ownership(
    p_project_id uuid,
    p_new_owner_id uuid
)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project public.projects%rowtype;
    v_actor_role public.project_role;
    v_new_role public.project_role;
begin
    v_project := private.lock_project_state(p_project_id);
    v_actor_role := private.lock_project_role(p_project_id, v_user);
    v_new_role := private.lock_project_role(p_project_id, p_new_owner_id);
    if v_actor_role is distinct from 'owner'::public.project_role then
        raise exception 'only the current owner can transfer ownership'
            using errcode = 'insufficient_privilege';
    end if;
    if p_new_owner_id = v_user then
        raise exception 'cannot transfer ownership to yourself';
    end if;
    if v_new_role is null then
        raise exception 'new owner must be a project member';
    end if;
    if v_project.status <> 'active' then
        raise exception 'project is archived';
    end if;

    update public.project_members
       set role = 'admin'
     where project_id = p_project_id and user_id = v_user;
    update public.project_members
       set role = 'owner'
     where project_id = p_project_id and user_id = p_new_owner_id;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values
        (p_project_id, v_user, 'role_changed', 'project_member', v_user,
         jsonb_build_object('user_id', v_user, 'role', 'owner'),
         jsonb_build_object('user_id', v_user, 'role', 'admin')),
        (p_project_id, v_user, 'role_changed', 'project_member', p_new_owner_id,
         jsonb_build_object('user_id', p_new_owner_id, 'role', v_new_role),
         jsonb_build_object('user_id', p_new_owner_id, 'role', 'owner'));
end;
$$;

create or replace function public.add_task_assignee(p_task_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_actor_role public.project_role;
    v_target_role public.project_role;
begin
    if v_project_id is null then raise exception 'task not found'; end if;
    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(p_task_id);
    v_actor_role := private.lock_project_role(v_project_id, v_user);
    v_target_role := private.lock_project_role(v_project_id, p_user_id);
    if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can manage assignees'
            using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived' or v_project.status <> 'active' then
        raise exception 'task is archived';
    end if;
    if v_target_role is null then
        raise exception 'assignee must be a project member';
    end if;
    if exists (
        select 1 from public.task_assignees
         where task_id = p_task_id and user_id = p_user_id
    ) then
        return;
    end if;

    insert into public.task_assignees(task_id, user_id, assigned_by)
    values (p_task_id, p_user_id, v_user);
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, new_data)
    values (
        v_project_id,
        v_user,
        'assignee_added',
        'task_assignee',
        p_user_id,
        jsonb_build_object('task_id', p_task_id, 'user_id', p_user_id)
    );
end;
$$;

create or replace function public.remove_task_assignee(p_task_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_actor_role public.project_role;
begin
    if v_project_id is null then raise exception 'task not found'; end if;
    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(p_task_id);
    v_actor_role := private.lock_project_role(v_project_id, v_user);
    if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can manage assignees'
            using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived' or v_project.status <> 'active' then
        raise exception 'task is archived';
    end if;
    if not exists (
        select 1 from public.task_assignees
         where task_id = p_task_id and user_id = p_user_id
    ) then
        return;
    end if;

    delete from public.task_assignees
     where task_id = p_task_id and user_id = p_user_id;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, new_data)
    values (
        v_project_id,
        v_user,
        'assignee_removed',
        'task_assignee',
        p_user_id,
        jsonb_build_object('task_id', p_task_id, 'user_id', p_user_id)
    );
end;
$$;

drop trigger if exists trg_projects_audit on public.projects;
drop trigger if exists trg_tasks_audit on public.tasks;
drop function if exists private.audit_entity_update();

-- Checklist mutation paths all use the same lock order: project -> task ->
-- item. Authorization and archived-state checks run only after those locks are
-- held, closing membership-revocation and archive races.
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
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_role public.project_role;
    v_title text := btrim(coalesce(p_title, ''));
    v_description text := nullif(btrim(coalesce(p_description, '')), '');
    v_position numeric;
    v_id uuid;
begin
    if v_project_id is null then raise exception 'task not found'; end if;
    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(p_task_id);
    v_role := private.lock_task_role(p_task_id, v_project_id, v_user);

    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'checklist admin role required'
            using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived' or v_project.status <> 'active' then
        raise exception 'task is archived';
    end if;
    if char_length(v_title) not between 1 and 500 then
        raise exception 'item title must contain 1..500 characters';
    end if;
    if v_description is not null and char_length(v_description) > 10000 then
        raise exception 'item description is too long';
    end if;
    if p_position is not null and (p_position < 0 or p_position = 'NaN'::numeric) then
        raise exception 'item position must be a non-negative finite number';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('task-items:' || p_task_id::text, 0));
    if p_position is null then
        select coalesce(max(position), 0) + 1
          into v_position
          from public.task_items
         where task_id = p_task_id;
    else
        v_position := p_position;
    end if;

    insert into public.task_items(task_id, title, description, position)
    values (p_task_id, v_title, v_description, v_position)
    returning id into v_id;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, new_data)
    values (
        v_project_id,
        v_user,
        'created',
        'task_item',
        v_id,
        jsonb_build_object(
            'task_id', p_task_id,
            'title', v_title,
            'description', v_description,
            'position', v_position
        )
    );
    return v_id;
end;
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
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_role public.project_role;
    v_item public.task_items%rowtype;
    v_title text;
    v_description text;
    v_old jsonb := '{}'::jsonb;
    v_new jsonb := '{}'::jsonb;
    v_action public.audit_action;
begin
    select task_id into v_task_id from public.task_items where id = p_task_item_id;
    if not found then raise exception 'task item not found'; end if;
    v_project_id := private.task_project_id(v_task_id);
    if v_project_id is null then raise exception 'task not found'; end if;

    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(v_task_id);
    v_role := private.lock_task_role(v_task_id, v_project_id, v_user);
    select * into v_item
      from public.task_items
     where id = p_task_item_id
     for update;
    if not found or v_item.task_id <> v_task_id then
        raise exception 'task item not found';
    end if;

    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'checklist admin role required'
            using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived'
       or v_project.status <> 'active'
       or v_item.is_archived then
        raise exception 'task item is archived';
    end if;
    if p_position is not null and (p_position < 0 or p_position = 'NaN'::numeric) then
        raise exception 'item position must be a non-negative finite number';
    end if;

    if p_title is not null then
        v_title := btrim(p_title);
        if char_length(v_title) not between 1 and 500 then
            raise exception 'item title must contain 1..500 characters';
        end if;
        if v_title is distinct from v_item.title then
            v_old := v_old || jsonb_build_object('title', v_item.title);
            v_new := v_new || jsonb_build_object('title', v_title);
        end if;
    end if;

    if p_description is not null then
        v_description := nullif(btrim(p_description), '');
        if v_description is not null and char_length(v_description) > 10000 then
            raise exception 'item description is too long';
        end if;
        if v_description is distinct from v_item.description then
            v_old := v_old || jsonb_build_object('description', v_item.description);
            v_new := v_new || jsonb_build_object('description', v_description);
        end if;
    end if;

    if p_position is not null and p_position is distinct from v_item.position then
        v_old := v_old || jsonb_build_object('position', v_item.position);
        v_new := v_new || jsonb_build_object('position', p_position);
    end if;
    if v_new = '{}'::jsonb then return; end if;

    update public.task_items
       set title = coalesce(v_title, title),
           description = case when p_description is null then description else v_description end,
           position = coalesce(p_position, position)
     where id = p_task_item_id;

    v_action := case
        when (select count(*) from jsonb_object_keys(v_new)) = 1 and v_new ? 'position'
            then 'reordered'::public.audit_action
        else 'updated'::public.audit_action
    end;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (v_project_id, v_user, v_action, 'task_item', p_task_item_id, v_old, v_new);
end;
$$;

create or replace function public.set_task_item_comment(
    p_task_item_id uuid,
    p_comment text
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
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_role public.project_role;
    v_item public.task_items%rowtype;
    v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
begin
    if v_comment is not null and char_length(v_comment) > 10000 then
        raise exception 'item comment is too long';
    end if;
    select task_id into v_task_id from public.task_items where id = p_task_item_id;
    if not found then raise exception 'task item not found'; end if;
    v_project_id := private.task_project_id(v_task_id);
    if v_project_id is null then raise exception 'task not found'; end if;

    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(v_task_id);
    v_role := private.lock_task_role(v_task_id, v_project_id, v_user);
    select * into v_item
      from public.task_items
     where id = p_task_item_id
     for update;
    if not found or v_item.task_id <> v_task_id then
        raise exception 'task item not found';
    end if;

    if v_role is null or v_role not in ('owner', 'admin', 'member') then
        raise exception 'no access to task item' using errcode = 'insufficient_privilege';
    end if;
    if v_item.is_archived
       or v_task.status = 'archived'
       or v_project.status <> 'active' then
        raise exception 'task item is archived';
    end if;
    if v_item.comment is not distinct from v_comment then return; end if;

    update public.task_items set comment = v_comment where id = p_task_item_id;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_project_id,
        v_user,
        'updated',
        'task_item',
        p_task_item_id,
        jsonb_build_object('comment', v_item.comment),
        jsonb_build_object('comment', v_comment)
    );
end;
$$;

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
    v_task_id uuid;
    v_project_id uuid;
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_role public.project_role;
    v_item public.task_items%rowtype;
    v_completed boolean := p_percentage = 100;
begin
    if p_percentage is null or p_percentage not between 0 and 100 then
        raise exception 'percentage must be between 0 and 100';
    end if;
    select task_id into v_task_id from public.task_items where id = p_task_item_id;
    if not found then raise exception 'task item not found'; end if;
    v_project_id := private.task_project_id(v_task_id);
    if v_project_id is null then raise exception 'task not found'; end if;

    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(v_task_id);
    v_role := private.lock_task_role(v_task_id, v_project_id, v_user);
    select * into v_item
      from public.task_items
     where id = p_task_item_id
     for update;
    if not found or v_item.task_id <> v_task_id then
        raise exception 'task item not found';
    end if;

    if v_role is null or v_role not in ('owner', 'admin', 'member') then
        raise exception 'no access to task item' using errcode = 'insufficient_privilege';
    end if;
    if v_item.is_archived
       or v_task.status = 'archived'
       or v_project.status <> 'active' then
        raise exception 'task item is archived';
    end if;
    if v_item.percentage = p_percentage and v_item.is_completed = v_completed then
        return p_percentage;
    end if;

    update public.task_items
       set percentage = p_percentage, is_completed = v_completed
     where id = p_task_item_id;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_project_id,
        v_user,
        'updated',
        'task_item',
        p_task_item_id,
        jsonb_build_object('percentage', v_item.percentage, 'is_completed', v_item.is_completed),
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
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_role public.project_role;
    v_item public.task_items%rowtype;
    v_action public.item_action_type;
    v_percentage integer;
begin
    if p_completed is null then raise exception 'completed state is required'; end if;
    v_percentage := case when p_completed then 100 else 0 end;
    select task_id into v_task_id from public.task_items where id = p_task_item_id;
    if not found then raise exception 'task item not found'; end if;
    v_project_id := private.task_project_id(v_task_id);
    if v_project_id is null then raise exception 'task not found'; end if;

    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(v_task_id);
    v_role := private.lock_task_role(v_task_id, v_project_id, v_user);
    select * into v_item
      from public.task_items
     where id = p_task_item_id
     for update;
    if not found or v_item.task_id <> v_task_id then
        raise exception 'task item not found';
    end if;

    if v_role is null or v_role not in ('owner', 'admin', 'member') then
        raise exception 'no access to task item' using errcode = 'insufficient_privilege';
    end if;
    if v_item.is_archived
       or v_task.status = 'archived'
       or v_project.status <> 'active' then
        raise exception 'task item is archived';
    end if;
    if v_item.is_completed = p_completed and v_item.percentage = v_percentage then
        return p_completed;
    end if;

    update public.task_items
       set percentage = v_percentage, is_completed = p_completed
     where id = p_task_item_id;

    v_action := case
        when p_completed then 'checked'::public.item_action_type
        else 'unchecked'::public.item_action_type
    end;
    if v_item.is_completed is distinct from p_completed then
        insert into public.item_actions(project_id, task_id, task_item_id, user_id, action)
        values (v_project_id, v_task_id, p_task_item_id, v_user, v_action);
    end if;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_project_id,
        v_user,
        v_action::text::public.audit_action,
        'task_item',
        p_task_item_id,
        jsonb_build_object('percentage', v_item.percentage, 'is_completed', v_item.is_completed),
        jsonb_build_object('percentage', v_percentage, 'is_completed', p_completed)
    );
    return p_completed;
end;
$$;

create or replace function public.archive_task_item(p_task_item_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_task_id uuid;
    v_project_id uuid;
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_role public.project_role;
    v_item public.task_items%rowtype;
    v_archived_at timestamptz := now();
begin
    select task_id into v_task_id from public.task_items where id = p_task_item_id;
    if not found then raise exception 'task item not found'; end if;
    v_project_id := private.task_project_id(v_task_id);
    if v_project_id is null then raise exception 'task not found'; end if;

    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(v_task_id);
    v_role := private.lock_task_role(v_task_id, v_project_id, v_user);
    select * into v_item
      from public.task_items
     where id = p_task_item_id
     for update;
    if not found or v_item.task_id <> v_task_id then
        raise exception 'task item not found';
    end if;
    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'checklist admin role required'
            using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived' or v_project.status <> 'active' then
        raise exception 'task is archived';
    end if;
    if v_item.is_archived then return; end if;

    update public.task_items
       set is_archived = true, archived_at = v_archived_at
     where id = p_task_item_id;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_project_id,
        v_user,
        'archived',
        'task_item',
        p_task_item_id,
        jsonb_build_object('is_archived', false, 'archived_at', null),
        jsonb_build_object('is_archived', true, 'archived_at', v_archived_at)
    );
end;
$$;

create or replace function public.hard_delete_task_item(p_task_item_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_task_id uuid;
    v_project_id uuid;
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_role public.project_role;
    v_item public.task_items%rowtype;
begin
    select task_id into v_task_id from public.task_items where id = p_task_item_id;
    if not found then raise exception 'task item not found'; end if;
    v_project_id := private.task_project_id(v_task_id);
    if v_project_id is null then raise exception 'task not found'; end if;

    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(v_task_id);
    v_role := private.lock_task_role(v_task_id, v_project_id, v_user);
    select * into v_item
      from public.task_items
     where id = p_task_item_id
     for update;
    if not found or v_item.task_id <> v_task_id then
        raise exception 'task item not found';
    end if;
    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'checklist admin role required'
            using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived' or v_project.status <> 'active' then
        raise exception 'task is archived';
    end if;
    if not v_item.is_archived then
        raise exception 'only archived task items can be hard deleted';
    end if;

    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data)
    values (
        v_project_id,
        v_user,
        'removed',
        'task_item',
        p_task_item_id,
        jsonb_build_object(
            'task_id', v_task_id,
            'title', v_item.title,
            'archived_at', v_item.archived_at
        )
    );
    delete from public.task_items where id = p_task_item_id;
end;
$$;

-- Template mutations follow the same parent-before-child lock rule and emit
-- complete creator-visible audit events.
drop function if exists public.delete_task_template_item(uuid);
drop function if exists public.remove_task_template_item(uuid);

create or replace function public.create_task_template(
    p_name text,
    p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_name text := btrim(coalesce(p_name, ''));
    v_description text := nullif(btrim(coalesce(p_description, '')), '');
    v_id uuid;
begin
    if char_length(v_name) not between 1 and 500 then
        raise exception 'template name must contain 1..500 characters';
    end if;
    if v_description is not null and char_length(v_description) > 10000 then
        raise exception 'template description is too long';
    end if;

    insert into public.task_templates(name, description, created_by)
    values (v_name, v_description, v_user)
    returning id into v_id;
    insert into public.audit_log(user_id, action, entity_type, entity_id, new_data)
    values (
        v_user,
        'created',
        'task_template',
        v_id,
        jsonb_build_object(
            'name', v_name,
            'description', v_description,
            'created_by', v_user
        )
    );
    return v_id;
end;
$$;

create or replace function public.update_task_template(
    p_template_id uuid,
    p_name text default null,
    p_description text default null
)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_template public.task_templates%rowtype;
    v_name text;
    v_description text;
begin
    select * into v_template
      from public.task_templates
     where id = p_template_id
     for update;
    if not found or v_template.archived_at is not null then
        raise exception 'template not found';
    end if;
    if v_template.created_by <> v_user then
        raise exception 'only template creator can edit it'
            using errcode = 'insufficient_privilege';
    end if;

    v_name := case when p_name is null then v_template.name else btrim(p_name) end;
    v_description := case
        when p_description is null then v_template.description
        else nullif(btrim(p_description), '')
    end;
    if char_length(v_name) not between 1 and 500 then
        raise exception 'template name must contain 1..500 characters';
    end if;
    if v_description is not null and char_length(v_description) > 10000 then
        raise exception 'template description is too long';
    end if;
    if v_name is not distinct from v_template.name
       and v_description is not distinct from v_template.description then
        return;
    end if;

    update public.task_templates
       set name = v_name, description = v_description
     where id = p_template_id;
    insert into public.audit_log(user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_user,
        'updated',
        'task_template',
        p_template_id,
        jsonb_build_object(
            'name', v_template.name,
            'description', v_template.description,
            'created_by', v_template.created_by
        ),
        jsonb_build_object(
            'name', v_name,
            'description', v_description,
            'created_by', v_template.created_by
        )
    );
end;
$$;

create or replace function public.archive_task_template(p_template_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_template public.task_templates%rowtype;
    v_archived_at timestamptz := now();
begin
    select * into v_template
      from public.task_templates
     where id = p_template_id
     for update;
    if not found or v_template.archived_at is not null then
        raise exception 'template not found';
    end if;
    if v_template.created_by <> v_user then
        raise exception 'only template creator can archive it'
            using errcode = 'insufficient_privilege';
    end if;

    update public.task_templates set archived_at = v_archived_at where id = p_template_id;
    insert into public.audit_log(user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_user,
        'archived',
        'task_template',
        p_template_id,
        jsonb_build_object('archived_at', v_template.archived_at, 'created_by', v_template.created_by),
        jsonb_build_object('archived_at', v_archived_at, 'created_by', v_template.created_by)
    );
end;
$$;

create or replace function public.create_task_template_item(
    p_template_id uuid,
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
    v_template public.task_templates%rowtype;
    v_title text := btrim(coalesce(p_title, ''));
    v_description text := nullif(btrim(coalesce(p_description, '')), '');
    v_position numeric;
    v_id uuid;
begin
    select * into v_template
      from public.task_templates
     where id = p_template_id
     for update;
    if not found or v_template.archived_at is not null then
        raise exception 'template not found';
    end if;
    if v_template.created_by <> v_user then
        raise exception 'only template creator can edit it'
            using errcode = 'insufficient_privilege';
    end if;
    if char_length(v_title) not between 1 and 500 then
        raise exception 'template item title must contain 1..500 characters';
    end if;
    if v_description is not null and char_length(v_description) > 10000 then
        raise exception 'template item description is too long';
    end if;
    if p_position is not null and (p_position < 0 or p_position = 'NaN'::numeric) then
        raise exception 'template item position must be a non-negative finite number';
    end if;

    select coalesce(p_position, coalesce(max(position), 0) + 1)
      into v_position
      from public.task_template_items
     where template_id = p_template_id;
    insert into public.task_template_items(template_id, title, description, position)
    values (p_template_id, v_title, v_description, v_position)
    returning id into v_id;
    insert into public.audit_log(user_id, action, entity_type, entity_id, new_data)
    values (
        v_user,
        'created',
        'task_template_item',
        v_id,
        jsonb_build_object(
            'template_id', p_template_id,
            'title', v_title,
            'description', v_description,
            'position', v_position
        )
    );
    return v_id;
end;
$$;

create or replace function public.update_task_template_item(
    p_item_id uuid,
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
    v_template_id uuid;
    v_template public.task_templates%rowtype;
    v_item public.task_template_items%rowtype;
    v_title text;
    v_description text;
    v_position numeric;
begin
    select template_id into v_template_id
      from public.task_template_items
     where id = p_item_id;
    if not found then raise exception 'template item not found'; end if;

    select * into v_template
      from public.task_templates
     where id = v_template_id
     for update;
    select * into v_item
      from public.task_template_items
     where id = p_item_id
     for update;
    if not found or v_item.template_id <> v_template_id then
        raise exception 'template item not found';
    end if;
    if v_template.archived_at is not null or v_template.created_by <> v_user then
        raise exception 'no permission to edit template item'
            using errcode = 'insufficient_privilege';
    end if;

    v_title := case when p_title is null then v_item.title else btrim(p_title) end;
    v_description := case
        when p_description is null then v_item.description
        else nullif(btrim(p_description), '')
    end;
    v_position := coalesce(p_position, v_item.position);
    if char_length(v_title) not between 1 and 500 then
        raise exception 'template item title must contain 1..500 characters';
    end if;
    if v_description is not null and char_length(v_description) > 10000 then
        raise exception 'template item description is too long';
    end if;
    if v_position < 0 or v_position = 'NaN'::numeric then
        raise exception 'template item position must be a non-negative finite number';
    end if;
    if v_title is not distinct from v_item.title
       and v_description is not distinct from v_item.description
       and v_position is not distinct from v_item.position then
        return;
    end if;

    update public.task_template_items
       set title = v_title, description = v_description, position = v_position
     where id = p_item_id;
    insert into public.audit_log(user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_user,
        case when v_title is not distinct from v_item.title
                   and v_description is not distinct from v_item.description
             then 'reordered'::public.audit_action
             else 'updated'::public.audit_action end,
        'task_template_item',
        p_item_id,
        jsonb_build_object(
            'template_id', v_template_id,
            'title', v_item.title,
            'description', v_item.description,
            'position', v_item.position
        ),
        jsonb_build_object(
            'template_id', v_template_id,
            'title', v_title,
            'description', v_description,
            'position', v_position
        )
    );
end;
$$;

create or replace function public.delete_task_template_item(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_template_id uuid;
    v_template public.task_templates%rowtype;
    v_item public.task_template_items%rowtype;
begin
    select template_id into v_template_id
      from public.task_template_items
     where id = p_item_id;
    if not found then raise exception 'template item not found'; end if;

    select * into v_template
      from public.task_templates
     where id = v_template_id
     for update;
    select * into v_item
      from public.task_template_items
     where id = p_item_id
     for update;
    if not found or v_item.template_id <> v_template_id then
        raise exception 'template item not found';
    end if;
    if v_template.archived_at is not null or v_template.created_by <> v_user then
        raise exception 'no permission to remove template item'
            using errcode = 'insufficient_privilege';
    end if;

    insert into public.audit_log(user_id, action, entity_type, entity_id, old_data)
    values (
        v_user,
        'removed',
        'task_template_item',
        p_item_id,
        jsonb_build_object(
            'template_id', v_template_id,
            'title', v_item.title,
            'description', v_item.description,
            'position', v_item.position
        )
    );
    delete from public.task_template_items where id = p_item_id;
end;
$$;

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
    v_project public.projects%rowtype;
    v_role public.project_role;
    v_template public.task_templates%rowtype;
    v_item record;
begin
    v_project := private.lock_project_state(p_project_id);
    v_role := private.lock_project_role(p_project_id, v_user);
    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can create stages from templates'
            using errcode = 'insufficient_privilege';
    end if;
    if v_project.status <> 'active' then
        raise exception 'project is archived';
    end if;

    select * into v_template
      from public.task_templates
     where id = p_template_id and archived_at is null
     for update;
    if not found then raise exception 'template not found'; end if;

    v_task_id := public.create_task(
        p_project_id,
        coalesce(nullif(btrim(p_title), ''), v_template.name),
        case when p_description is null
             then v_template.description
             else nullif(btrim(p_description), '') end
    );
    for v_item in
        select title, description, position
          from public.task_template_items
         where template_id = p_template_id
         order by position, created_at
    loop
        insert into public.task_items(task_id, title, description, position, is_completed, percentage, comment)
        values (v_task_id, v_item.title, v_item.description, v_item.position, false, 0, null);
    end loop;

    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, new_data)
    values (
        p_project_id,
        v_user,
        'created',
        'task_from_template',
        v_task_id,
        jsonb_build_object('task_id', v_task_id, 'template_id', p_template_id)
    );
    return v_task_id;
end;
$$;

-- Audit-to-notification mapping uses stage/checklist terminology and gives
-- role overrides their own non-misleading notification type.
create or replace function private.audit_to_notification()
returns trigger
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_task_id uuid;
    v_type public.notification_type;
    v_title text;
    v_body text;
    v_recipient uuid;
    v_project_name text;
    v_task_title text;
    v_item_title text;
    v_person_name text;
    v_change_summary text;
    v_role_label text;
    v_actor uuid := coalesce(new.user_id, '00000000-0000-0000-0000-000000000000'::uuid);
begin
    if new.action = 'role_changed' and new.entity_type = 'task_member' then
        v_type := 'task_role_changed';
        v_recipient := new.entity_id;
        v_task_id := nullif(new.new_data->>'task_id', '')::uuid;
        v_title := 'Права чек-листа изменены';
    elsif new.action = 'assignee_added' then
        v_type := 'task_assigned';
        v_recipient := new.entity_id;
        v_task_id := nullif(new.new_data->>'task_id', '')::uuid;
        v_title := 'Вас назначили исполнителем';
    elsif new.action = 'assignee_removed' then
        v_type := 'task_unassigned';
        v_recipient := new.entity_id;
        v_task_id := nullif(new.new_data->>'task_id', '')::uuid;
        v_title := 'Назначение снято';
    elsif new.action in ('checked', 'unchecked') then
        v_type := case when new.action = 'checked'
                       then 'task_item_checked' else 'task_item_unchecked' end;
        v_title := case when new.action = 'checked'
                        then 'Пункт отмечен' else 'Отметка пункта снята' end;
        select task_id, title into v_task_id, v_item_title
          from public.task_items where id = new.entity_id;
    elsif new.action = 'updated'
      and new.entity_type = 'task_item'
      and (new.new_data ? 'title'
        or new.new_data ? 'description'
        or new.new_data ? 'position'
        or new.new_data ? 'percentage'
        or new.new_data ? 'comment'
        or new.new_data ? 'is_completed') then
        v_type := 'task_item_changed';
        v_title := 'Изменён пункт чек-листа';
        select task_id, title into v_task_id, v_item_title
          from public.task_items where id = new.entity_id;
    elsif new.action = 'archived' and new.entity_type = 'project' then
        v_type := 'project_archived';
        v_title := 'Проект архивирован';
    elsif new.action = 'restored' and new.entity_type = 'project' then
        v_type := 'project_restored';
        v_title := 'Проект восстановлен';
    elsif new.action = 'archived' and new.entity_type = 'task' then
        v_type := 'task_archived';
        v_task_id := new.entity_id;
        v_title := 'Этап архивирован';
    elsif new.action = 'restored' and new.entity_type = 'task' then
        v_type := 'task_restored';
        v_task_id := new.entity_id;
        v_title := 'Этап восстановлен';
    else
        return new;
    end if;

    if new.entity_type = 'project' and new.action in ('archived', 'restored') then
        select name into v_project_name from public.projects where id = new.project_id;
        v_body := format(
            'Проект «%s» %s.',
            coalesce(v_project_name, 'Без названия'),
            case when new.action = 'archived' then 'архивирован' else 'восстановлен' end
        );
        for v_recipient in
            select pm.user_id
              from public.project_members pm
             where pm.project_id = new.project_id and pm.user_id <> v_actor
        loop
            perform private.create_notification(
                v_recipient,
                new.project_id,
                null,
                v_type,
                v_title,
                v_body,
                jsonb_build_object('project_id', new.project_id),
                'audit:' || new.id::text
            );
        end loop;
        return new;
    end if;

    if v_task_id is null then return new; end if;
    select p.name, t.title
      into v_project_name, v_task_title
      from public.tasks t
      join public.projects p on p.id = t.project_id
     where t.id = v_task_id;
    v_project_name := coalesce(v_project_name, 'Без названия');
    v_task_title := coalesce(v_task_title, 'Без названия');

    if new.action in ('archived', 'restored') and new.entity_type = 'task' then
        v_body := format(
            'Этап «%s» в проекте «%s» %s.',
            v_task_title,
            v_project_name,
            case when new.action = 'archived' then 'архивирован' else 'восстановлен' end
        );
        for v_recipient in
            select pm.user_id
              from public.project_members pm
             where pm.project_id = new.project_id and pm.user_id <> v_actor
        loop
            perform private.create_notification(
                v_recipient,
                new.project_id,
                v_task_id,
                v_type,
                v_title,
                v_body,
                jsonb_build_object('task_id', v_task_id),
                'audit:' || new.id::text
            );
        end loop;
        return new;
    end if;

    if new.action = 'role_changed' and new.entity_type = 'task_member' then
        if new.new_data->>'role_override' is null then
            v_body := format(
                'Права чек-листа этапа «%s» снова наследуются от роли в проекте «%s».',
                v_task_title,
                v_project_name
            );
        else
            v_role_label := case new.new_data->>'role_override'
                when 'admin' then 'Администратор чек-листа'
                when 'member' then 'Участник'
                when 'viewer' then 'Только просмотр'
                else new.new_data->>'role_override'
            end;
            v_body := format(
                'Для чек-листа этапа «%s» в проекте «%s» установлена роль «%s».',
                v_task_title,
                v_project_name,
                v_role_label
            );
        end if;
    elsif new.action = 'assignee_added' then
        v_body := format(
            'Вы назначены исполнителем этапа «%s» в проекте «%s».',
            v_task_title,
            v_project_name
        );
    elsif new.action = 'assignee_removed' then
        v_body := format(
            'С вас снято назначение на этапе «%s» проекта «%s».',
            v_task_title,
            v_project_name
        );
    elsif new.action in ('checked', 'unchecked') then
        v_body := format(
            '«%s» → этап «%s» → проект «%s».',
            coalesce(v_item_title, 'Пункт чек-листа'),
            v_task_title,
            v_project_name
        );
    else
        v_change_summary := concat_ws(', ',
            case when new.new_data ? 'title' then 'название' end,
            case when new.new_data ? 'description' then 'описание' end,
            case when new.new_data ? 'position' then 'порядок' end,
            case when new.new_data ? 'percentage'
                 then format('прогресс %s%%', new.new_data->>'percentage') end,
            case when new.new_data ? 'comment' then 'комментарий' end,
            case when new.new_data ? 'is_completed'
                       and not (new.new_data ? 'percentage') then 'состояние' end
        );
        v_body := format(
            'Пункт «%s» изменён (%s) на этапе «%s» проекта «%s».',
            coalesce(v_item_title, 'Пункт чек-листа'),
            coalesce(v_change_summary, 'данные'),
            v_task_title,
            v_project_name
        );
    end if;

    if new.action in ('checked', 'unchecked', 'updated') then
        for v_recipient in
            select pm.user_id
              from public.project_members pm
             where pm.project_id = new.project_id
               and pm.user_id <> v_actor
               and private.has_task_access(v_task_id, pm.user_id)
        loop
            perform private.create_notification(
                v_recipient,
                new.project_id,
                v_task_id,
                v_type,
                v_title,
                v_body,
                jsonb_build_object('task_id', v_task_id, 'entity_id', new.entity_id),
                'audit:' || new.id::text
            );
        end loop;
    elsif v_recipient is not null and v_recipient <> v_actor then
        perform private.create_notification(
            v_recipient,
            new.project_id,
            v_task_id,
            v_type,
            v_title,
            v_body,
            jsonb_build_object('task_id', v_task_id),
            'audit:' || new.id::text
        );
    end if;
    return new;
end;
$$;

-- Realtime uses private Broadcast topics with RLS authorization. Payloads are
-- deliberately limited to table/operation invalidation signals (plus the
-- opaque message UUID added by realtime.send); no row data or DELETE keys are
-- broadcast.
create or replace function private.can_receive_realtime_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = private, public
as $$
declare
    v_user uuid := auth.uid();
    v_kind text := split_part(p_topic, ':', 1);
    v_value text := split_part(p_topic, ':', 2);
    v_id uuid;
begin
    if v_user is null
       or p_topic <> (v_kind || ':' || v_value)
       or v_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        return false;
    end if;
    v_id := v_value::uuid;

    if v_kind = 'user' then
        return v_id = v_user;
    elsif v_kind = 'project' then
        return private.is_project_member(v_id, v_user);
    elsif v_kind = 'task' then
        return private.has_task_access(v_id, v_user);
    end if;
    return false;
end;
$$;

revoke all on function private.can_receive_realtime_topic(text)
    from public, anon, service_role;
grant execute on function private.can_receive_realtime_topic(text)
    to authenticated;

drop policy if exists tasktrace_broadcast_read on realtime.messages;
create policy tasktrace_broadcast_read
on realtime.messages
for select
to authenticated
using (
    extension = 'broadcast'
    and private.can_receive_realtime_topic(realtime.topic())
);

create or replace function private.broadcast_application_invalidation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
    v_project_id uuid;
    v_task_id uuid;
    v_user_id uuid;
    v_recipient uuid;
    v_payload jsonb := jsonb_build_object('table', tg_table_name, 'operation', tg_op);
begin
    if tg_table_name = 'projects' then
        v_project_id := nullif(v_row->>'id', '')::uuid;
    elsif tg_table_name = 'project_members' then
        v_project_id := nullif(v_row->>'project_id', '')::uuid;
        v_user_id := nullif(v_row->>'user_id', '')::uuid;
    elsif tg_table_name = 'tasks' then
        v_project_id := nullif(v_row->>'project_id', '')::uuid;
        v_task_id := nullif(v_row->>'id', '')::uuid;
    elsif tg_table_name = 'task_items' then
        v_task_id := nullif(v_row->>'task_id', '')::uuid;
        select t.project_id into v_project_id
          from public.tasks t where t.id = v_task_id;
    elsif tg_table_name in ('task_members', 'task_assignees') then
        v_task_id := nullif(v_row->>'task_id', '')::uuid;
        v_user_id := nullif(v_row->>'user_id', '')::uuid;
        select t.project_id into v_project_id
          from public.tasks t where t.id = v_task_id;
    elsif tg_table_name = 'notifications' then
        v_user_id := nullif(v_row->>'user_id', '')::uuid;
    else
        return null;
    end if;

    if v_project_id is not null then
        perform realtime.send(v_payload, 'invalidate', 'project:' || v_project_id::text, true);
    end if;
    if v_task_id is not null then
        perform realtime.send(v_payload, 'invalidate', 'task:' || v_task_id::text, true);
    end if;
    if v_user_id is not null then
        perform realtime.send(v_payload, 'invalidate', 'user:' || v_user_id::text, true);
    end if;
    if tg_table_name = 'projects' and v_project_id is not null and tg_op <> 'DELETE' then
        for v_recipient in
            select pm.user_id
              from public.project_members pm
             where pm.project_id = v_project_id
               and pm.user_id is distinct from v_user_id
        loop
            perform realtime.send(v_payload, 'invalidate', 'user:' || v_recipient::text, true);
        end loop;
    elsif tg_table_name = 'tasks' and v_task_id is not null and tg_op <> 'DELETE' then
        for v_recipient in
            select ta.user_id
              from public.task_assignees ta
             where ta.task_id = v_task_id
               and ta.user_id is distinct from v_user_id
        loop
            perform realtime.send(v_payload, 'invalidate', 'user:' || v_recipient::text, true);
        end loop;
    end if;
    return null;
end;
$$;

revoke all on function private.broadcast_application_invalidation()
    from public, anon, authenticated, service_role;

drop trigger if exists trg_projects_broadcast_invalidation on public.projects;
create trigger trg_projects_broadcast_invalidation
after insert or update or delete on public.projects
for each row execute function private.broadcast_application_invalidation();

drop trigger if exists trg_project_members_broadcast_invalidation on public.project_members;
create trigger trg_project_members_broadcast_invalidation
after insert or update or delete on public.project_members
for each row execute function private.broadcast_application_invalidation();

drop trigger if exists trg_tasks_broadcast_invalidation on public.tasks;
create trigger trg_tasks_broadcast_invalidation
after insert or update or delete on public.tasks
for each row execute function private.broadcast_application_invalidation();

drop trigger if exists trg_task_members_broadcast_invalidation on public.task_members;
create trigger trg_task_members_broadcast_invalidation
after insert or update or delete on public.task_members
for each row execute function private.broadcast_application_invalidation();

drop trigger if exists trg_task_assignees_broadcast_invalidation on public.task_assignees;
create trigger trg_task_assignees_broadcast_invalidation
after insert or update or delete on public.task_assignees
for each row execute function private.broadcast_application_invalidation();

drop trigger if exists trg_task_items_broadcast_invalidation on public.task_items;
create trigger trg_task_items_broadcast_invalidation
after insert or update or delete on public.task_items
for each row execute function private.broadcast_application_invalidation();

drop trigger if exists trg_notifications_broadcast_invalidation on public.notifications;
create trigger trg_notifications_broadcast_invalidation
after insert or update or delete on public.notifications
for each row execute function private.broadcast_application_invalidation();

-- Postgres Changes is no longer an application data plane. This removes the
-- fundamental DELETE/RLS leakage rather than attempting an ineffective filter.
do $$
declare
    v_table text;
begin
    foreach v_table in array array[
        'projects',
        'project_members',
        'tasks',
        'task_members',
        'task_assignees',
        'task_items',
        'item_actions',
        'audit_log',
        'notifications'
    ] loop
        if exists (
            select 1
              from pg_publication_tables
             where pubname = 'supabase_realtime'
               and schemaname = 'public'
               and tablename = v_table
        ) then
            execute format('alter publication supabase_realtime drop table public.%I', v_table);
        end if;
    end loop;
end;
$$;

-- The product has no privileged service-role CRUD API. Keep the Data API
-- contract minimal: authenticated users get only the documented RPCs and
-- scoped SELECT grants; service_role receives no application-table or RPC ACL.
alter function private.validate_item_action_context() set search_path = '';
alter function public.mark_all_notifications_read() set search_path = '';
alter function public.mark_notification_read(uuid) set search_path = '';

revoke all privileges on all tables in schema public from service_role;
revoke all privileges on all sequences in schema public from service_role;
revoke execute on all functions in schema public from public, anon, service_role;
revoke execute on all functions in schema private from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema public
    revoke execute on functions from public;
alter default privileges for role postgres in schema private
    revoke execute on functions from public;

grant execute on function public.add_project_member(uuid, uuid, public.project_role) to authenticated;
grant execute on function public.add_project_member_by_identifier(uuid, text, public.project_role) to authenticated;
grant execute on function public.add_task_assignee(uuid, uuid) to authenticated;
grant execute on function public.archive_project(uuid) to authenticated;
grant execute on function public.archive_task(uuid) to authenticated;
grant execute on function public.archive_task_item(uuid) to authenticated;
grant execute on function public.archive_task_template(uuid) to authenticated;
grant execute on function public.change_member_role(uuid, uuid, public.project_role) to authenticated;
grant execute on function public.clear_task_member_override(uuid, uuid) to authenticated;
grant execute on function public.create_project(text, text) to authenticated;
grant execute on function public.create_task(uuid, text, text) to authenticated;
grant execute on function public.create_task_from_template(uuid, uuid, text, text) to authenticated;
grant execute on function public.create_task_item(uuid, text, text, numeric) to authenticated;
grant execute on function public.create_task_template(text, text) to authenticated;
grant execute on function public.create_task_template_item(uuid, text, text, numeric) to authenticated;
grant execute on function public.delete_task_template_item(uuid) to authenticated;
grant execute on function public.get_my_profile() to authenticated;
grant execute on function public.get_my_task_role(uuid) to authenticated;
grant execute on function public.get_task_template(uuid) to authenticated;
grant execute on function public.hard_delete_project(uuid) to authenticated;
grant execute on function public.hard_delete_task(uuid) to authenticated;
grant execute on function public.hard_delete_task_item(uuid) to authenticated;
grant execute on function public.list_task_item_last_editors(uuid) to authenticated;
grant execute on function public.list_task_member_overrides(uuid) to authenticated;
grant execute on function public.list_task_template_items(uuid) to authenticated;
grant execute on function public.list_task_templates() to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;
grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.move_task(uuid, integer) to authenticated;
grant execute on function public.remove_project_member(uuid, uuid) to authenticated;
grant execute on function public.remove_task_assignee(uuid, uuid) to authenticated;
grant execute on function public.restore_project(uuid) to authenticated;
grant execute on function public.restore_task(uuid) to authenticated;
grant execute on function public.set_task_item_comment(uuid, text) to authenticated;
grant execute on function public.set_task_item_percentage(uuid, integer) to authenticated;
grant execute on function public.set_task_item_state(uuid, boolean) to authenticated;
grant execute on function public.set_task_member_override(uuid, uuid, public.project_role) to authenticated;
grant execute on function public.transfer_project_ownership(uuid, uuid) to authenticated;
grant execute on function public.update_my_profile(text) to authenticated;
grant execute on function public.update_project(uuid, text, text) to authenticated;
grant execute on function public.update_task(uuid, text, text) to authenticated;
grant execute on function public.update_task_item(uuid, text, text, numeric) to authenticated;
grant execute on function public.update_task_template(uuid, text, text) to authenticated;
grant execute on function public.update_task_template_item(uuid, text, text, numeric) to authenticated;

-- Only subject-bound RLS wrappers are client-executable.
grant execute on function private.audit_log_visible(uuid, text, uuid, jsonb, jsonb) to authenticated;
grant execute on function private.can_receive_realtime_topic(text) to authenticated;
grant execute on function private.can_view_profile(uuid) to authenticated;
grant execute on function private.current_has_task_access(uuid) to authenticated;
grant execute on function private.current_is_project_member(uuid) to authenticated;
grant execute on function private.current_is_task_project_admin(uuid) to authenticated;

comment on function public.get_my_profile() is
    'Returns the canonical profile and idempotently repairs a missing profile row for the authenticated user.';
comment on function public.set_task_member_override(uuid, uuid, public.project_role) is
    'Sets a checklist-only role override; never changes project_members or project authority.';
comment on function public.clear_task_member_override(uuid, uuid) is
    'Clears a checklist-only role override and restores inherited project-role behavior.';
