-- TaskTrace improve pass: self-service profile, archived hard deletes,
-- ownership notifications, and explicit role mutation grants.
alter type public.audit_action add value if not exists 'removed';

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

-- Audit rows retain deletion context after a project is purged.  item_actions
-- are focused immutable history and are removed only as part of hard delete.
alter table public.audit_log alter column project_id drop not null;
alter table public.audit_log drop constraint if exists audit_log_project_id_fkey;
alter table public.audit_log add constraint audit_log_project_id_fkey
    foreign key (project_id) references public.projects(id) on delete set null;

alter table public.item_actions alter column project_id drop not null;
alter table public.item_actions alter column task_id drop not null;
alter table public.item_actions alter column task_item_id drop not null;
alter table public.item_actions drop constraint if exists item_actions_project_id_fkey;
alter table public.item_actions drop constraint if exists item_actions_task_id_fkey;
alter table public.item_actions drop constraint if exists item_actions_task_item_id_fkey;
alter table public.item_actions drop constraint if exists item_actions_task_id_project_id_fkey;
alter table public.item_actions drop constraint if exists item_actions_task_item_id_task_id_fkey;
alter table public.item_actions add constraint item_actions_project_id_fkey
    foreign key (project_id) references public.projects(id) on delete set null;
alter table public.item_actions add constraint item_actions_task_id_fkey
    foreign key (task_id) references public.tasks(id) on delete set null;
alter table public.item_actions add constraint item_actions_task_item_id_fkey
    foreign key (task_item_id) references public.task_items(id) on delete set null;
alter table public.item_actions add constraint item_actions_task_project_consistency_fkey
    foreign key (task_id, project_id) references public.tasks(id, project_id);
alter table public.item_actions add constraint item_actions_item_task_consistency_fkey
    foreign key (task_item_id, task_id) references public.task_items(id, task_id);

create or replace function public.hard_delete_task_item(p_task_item_id uuid)
returns void language plpgsql security definer set search_path = private, public as $$
declare
    v_user uuid := private.require_auth();
    r public.task_items%rowtype;
    v_project uuid;
begin
    select * into r from public.task_items where id = p_task_item_id for update;
    if not found then raise exception 'task item not found'; end if;
    v_project := private.task_project_id(r.task_id);
    perform private.lock_project(v_project);
    if not private.is_project_admin(v_project) then raise exception 'only owner/admin can hard delete task items' using errcode='insufficient_privilege'; end if;
    if not r.is_archived then raise exception 'only archived task items can be hard deleted'; end if;
    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data)
    values(v_project,v_user,'removed','task_item',r.id,jsonb_build_object('task_id',r.task_id,'title',r.title,'archived_at',r.archived_at));
    delete from public.task_items where id = r.id;
end
$$;

create or replace function public.hard_delete_task(p_task_id uuid)
returns void language plpgsql security definer set search_path = private, public as $$
declare
    v_user uuid := private.require_auth();
    r public.tasks%rowtype;
begin
    select * into r from public.tasks where id = p_task_id for update;
    if not found then raise exception 'task not found'; end if;
    perform private.lock_project(r.project_id);
    if not private.is_project_admin(r.project_id) then raise exception 'only owner/admin can hard delete tasks' using errcode='insufficient_privilege'; end if;
    if r.status <> 'archived' then raise exception 'only archived tasks can be hard deleted'; end if;
    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data)
    values(r.project_id,v_user,'removed','task',r.id,jsonb_build_object('project_id',r.project_id,'title',r.title,'archived_at',r.archived_at));
    delete from public.tasks where id = r.id;
end
$$;

create or replace function public.hard_delete_project(p_project_id uuid)
returns void language plpgsql security definer set search_path = private, public as $$
declare
    v_user uuid := private.require_auth();
    r public.projects%rowtype;
begin
    perform private.lock_project(p_project_id);
    select * into r from public.projects where id = p_project_id for update;
    if not found then raise exception 'project not found'; end if;
    if private.project_role_of(p_project_id) <> 'owner' then raise exception 'only the owner can hard delete a project' using errcode='insufficient_privilege'; end if;
    if r.status <> 'archived' then raise exception 'only archived projects can be hard deleted'; end if;
    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data)
    values(null,v_user,'removed','project',r.id,jsonb_build_object('project_id',r.id,'name',r.name,'archived_at',r.archived_at));
    delete from public.projects where id = r.id;
end
$$;

revoke all on function public.hard_delete_task_item(uuid), public.hard_delete_task(uuid), public.hard_delete_project(uuid) from public, anon;
grant execute on function public.hard_delete_task_item(uuid), public.hard_delete_task(uuid), public.hard_delete_project(uuid) to authenticated;
