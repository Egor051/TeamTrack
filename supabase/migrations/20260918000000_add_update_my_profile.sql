-- Canonical self-service profile update RPC.
--
-- The hosted Supabase project was missing public.update_my_profile(text)
-- (PGRST202: "Could not find the function public.update_my_profile(p_display_name)
-- in the schema cache") because the improve-pass migration that introduces it
-- had never been applied there. This migration carries an independent, safe,
-- canonical definition of the RPC so it can be (re-)applied on its own:
--   * SECURITY DEFINER with a pinned search_path;
--   * only the calling user's own profile row is ever touched (auth.uid() is
--     mandatory — there is no way to target another user's profile);
--   * display_name is validated (2..80 chars after trim, restricted charset);
--   * EXECUTE is granted to authenticated only;
--   * the direct profiles UPDATE grant model is unchanged (RLS
--     profiles_update_self + column-level ACL still apply).
create or replace function public.update_my_profile(p_display_name text)
returns public.profiles
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_name text := btrim(coalesce(p_display_name, ''));
    v_profile public.profiles;
begin
    if length(v_name) < 2 or length(v_name) > 80 then
        raise exception 'display name must be between 2 and 80 characters';
    end if;
    if v_name !~ '^[[:alnum:]_ .-]+$' then
        raise exception 'display name contains unsupported characters';
    end if;
    update public.profiles set display_name = v_name where id = v_user returning * into v_profile;
    if not found then raise exception 'profile not found'; end if;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (null, v_user, 'updated', 'profile', v_user,
            jsonb_build_object('display_name', null),
            jsonb_build_object('display_name', v_name));
    return v_profile;
end
$$;

revoke all on function public.update_my_profile(text) from public, anon;
grant execute on function public.update_my_profile(text) to authenticated;
-- Hosted hard-delete/history reconciliation (remote 20260909221947).
-- The previous hard-delete migration added ON DELETE SET NULL FKs here. That
-- makes PostgreSQL issue UPDATEs against immutable history during a DELETE.

-- audit_log.project_id is a historical identifier, not a live relationship.
alter table public.audit_log
    drop constraint if exists audit_log_project_id_fkey;

-- item_actions stores denormalized historical identifiers. Remove all FKs that
-- would either UPDATE these columns (SET NULL) or block deletion (composite
-- consistency FKs). user_id remains a RESTRICT FK for actor attribution.
alter table public.item_actions
    drop constraint if exists item_actions_project_id_fkey,
    drop constraint if exists item_actions_task_id_fkey,
    drop constraint if exists item_actions_task_item_id_fkey,
    drop constraint if exists item_actions_task_project_consistency_fkey,
    drop constraint if exists item_actions_item_task_consistency_fkey;

alter table public.item_actions
    alter column project_id set not null,
    alter column task_id set not null,
    alter column task_item_id set not null;

-- Preserve the former composite-FK consistency guarantee for new history rows,
-- while allowing the referenced operational rows to be hard-deleted later.
create or replace function private.validate_item_action_context()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
begin
    if new.project_id is null or new.task_id is null or new.task_item_id is null then
        raise exception 'item_actions historical identifiers must not be null'
            using errcode = 'not_null_violation';
    end if;
    if not exists (
        select 1 from public.tasks t
        where t.id = new.task_id and t.project_id = new.project_id
    ) then
        raise exception 'item_actions task/project mismatch'
            using errcode = 'foreign_key_violation';
    end if;
    if not exists (
        select 1 from public.task_items ti
        where ti.id = new.task_item_id and ti.task_id = new.task_id
    ) then
        raise exception 'item_actions item/task mismatch'
            using errcode = 'foreign_key_violation';
    end if;
    return new;
end;
$$;

drop trigger if exists trg_item_actions_validate_context on public.item_actions;
create trigger trg_item_actions_validate_context
before insert on public.item_actions
for each row execute function private.validate_item_action_context();

revoke all on function private.validate_item_action_context() from public, anon, authenticated;

-- The removed-project audit event retains the deleted UUID. With the FK gone,
-- no follow-up UPDATE is needed and the append-only row remains intact.
create or replace function public.hard_delete_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    r public.projects%rowtype;
begin
    perform private.lock_project(p_project_id);
    select * into r from public.projects where id = p_project_id for update;
    if not found then raise exception 'project not found'; end if;
    if private.project_role_of(p_project_id) <> 'owner' then
        raise exception 'only the owner can hard delete a project'
            using errcode = 'insufficient_privilege';
    end if;
    if r.status <> 'archived' then
        raise exception 'only archived projects can be hard deleted';
    end if;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data)
    values (r.id, v_user, 'removed', 'project', r.id,
            jsonb_build_object('project_id', r.id, 'name', r.name, 'archived_at', r.archived_at));
    delete from public.projects where id = r.id;
end
$$;

revoke all on function public.hard_delete_project(uuid) from public, anon;
grant execute on function public.hard_delete_project(uuid) to authenticated;
