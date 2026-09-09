-- Production hardening fixes.
-- Forward-only migration layered on top of the final hosted-reconciliation state.

-- Explicitly distinguish restore events from ordinary updates.  The audit
-- trigger and notification trigger both use this value.
alter type public.audit_action add value if not exists 'restored';

alter type public.notification_type add value if not exists 'project_archived';
alter type public.notification_type add value if not exists 'project_restored';
alter type public.notification_type add value if not exists 'task_archived';
alter type public.notification_type add value if not exists 'task_restored';

-- A NULL marker means the task was archived directly.  A non-NULL marker is
-- the archive timestamp of the project operation that archived the task and
-- therefore makes restore_project selective and reversible.
alter table public.tasks
    add column if not exists archived_by_project_at timestamptz;
alter table public.tasks
    drop constraint if exists tasks_project_archive_marker_consistency;
alter table public.tasks
    add constraint tasks_project_archive_marker_consistency
    check (archived_by_project_at is null or status = 'archived');

create index if not exists idx_notifications_project
    on public.notifications(project_id);
create index if not exists idx_notifications_task
    on public.notifications(task_id);

-- task_members is intentionally narrower than project metadata: project
-- members without task access must not be able to enumerate task membership.
drop policy if exists task_members_select_project_member on public.task_members;
drop policy if exists task_members_select_task_member_or_admin on public.task_members;

create or replace function private.is_task_project_admin(
    p_task_id uuid,
    p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = private, public
as $$
    select private.is_project_admin(private.task_project_id(p_task_id), p_user_id)
$$;

create policy task_members_select_task_member_or_admin
on public.task_members for select
to authenticated
using (
    private.has_task_access(task_id)
    or private.is_task_project_admin(task_id)
);

-- Profiles are provisioned by the auth.users trigger.  Clients may update the
-- two profile fields granted by the existing column ACL, but never insert a
-- profile row directly.
revoke insert on public.profiles from authenticated;

-- Compute the active-checklist-derived status in one place.  Archived tasks
-- remain archived and are never changed by this helper.
create or replace function private.task_status_from_items(p_task_id uuid)
returns public.task_status
language sql
stable
security definer
set search_path = private, public
as $$
    select case
        when count(*) = 0 or coalesce(avg(ti.percentage), 0) = 0
            then 'not_started'::public.task_status
        when avg(ti.percentage) = 100
            then 'completed'::public.task_status
        else 'in_progress'::public.task_status
    end
    from public.task_items ti
    where ti.task_id = p_task_id
      and not ti.is_archived
$$;

create or replace function private.recalculate_task_status(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_status public.task_status;
begin
    select private.task_status_from_items(p_task_id) into v_status;
    update public.tasks
       set status = v_status,
           archived_at = null,
           archived_by_project_at = null
     where id = p_task_id
       and status <> 'archived'
       and status is distinct from v_status;
end
$$;

create or replace function private.recalculate_task_status_trigger()
returns trigger
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_task_id uuid := coalesce(new.task_id, old.task_id);
begin
    perform private.recalculate_task_status(v_task_id);
    if tg_op = 'DELETE' then
        return old;
    end if;
    return new;
end
$$;

drop trigger if exists trg_task_items_recalculate_status on public.task_items;
create trigger trg_task_items_recalculate_status
after insert or delete or update of percentage, is_completed, is_archived on public.task_items
for each row execute function private.recalculate_task_status_trigger();

revoke all on function private.is_task_project_admin(uuid, uuid), private.task_status_from_items(uuid), private.recalculate_task_status(uuid), private.recalculate_task_status_trigger()
    from public, anon, authenticated;
grant execute on function private.is_task_project_admin(uuid, uuid) to authenticated;

-- Reconcile pre-existing active rows once.  auth.uid() is NULL during a
-- migration, so the audit trigger intentionally does not attribute this
-- maintenance update to a user.
update public.tasks t
   set status = private.task_status_from_items(t.id),
       archived_at = null,
       archived_by_project_at = null
 where t.status <> 'archived'
   and t.status is distinct from private.task_status_from_items(t.id);

-- Make archive/restore transitions explicit in the immutable audit trail.
create or replace function private.audit_entity_update()
returns trigger
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_old jsonb;
    v_new jsonb;
    v_action public.audit_action;
    v_project_id uuid;
    v_entity text;
begin
    if auth.uid() is null then
        return null;
    end if;

    if tg_table_name = 'projects' then
        v_entity := 'project';
        v_project_id := old.id;
    else
        v_entity := 'task';
        v_project_id := old.project_id;
    end if;

    v_action := case
        when old.status <> 'archived' and new.status = 'archived'
            then 'archived'::public.audit_action
        when old.status = 'archived' and new.status <> 'archived'
            then 'restored'::public.audit_action
        else 'updated'::public.audit_action
    end;

    select jsonb_object_agg(o.key, o.value),
           jsonb_object_agg(n.key, n.value)
      into v_old, v_new
      from jsonb_each(to_jsonb(old)) o
      join jsonb_each(to_jsonb(new)) n using (key)
     where o.value is distinct from n.value;

    insert into public.audit_log
        (project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values
        (v_project_id, auth.uid(), v_action, v_entity, old.id, v_old, v_new);

    return null;
end
$$;

-- Contextual notification delivery for access, assignment, checklist and
-- archive/restore events.  Recipients are always derived from membership
-- tables, never from client-provided ids.
create or replace function private.audit_to_notification()
returns trigger
language plpgsql
security definer
set search_path = public, private
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
    v_actor uuid := coalesce(new.user_id, '00000000-0000-0000-0000-000000000000'::uuid);
begin
    if new.action = 'access_approved' then
        v_type := 'task_member_added';
        v_recipient := new.entity_id;
        v_task_id := nullif(new.new_data->>'task_id', '')::uuid;
        v_title := 'Доступ к задаче предоставлен';
    elsif new.action = 'access_revoked' then
        v_type := 'task_member_removed';
        v_recipient := new.entity_id;
        v_task_id := nullif(new.new_data->>'task_id', '')::uuid;
        v_title := 'Доступ к задаче отозван';
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
        v_type := case when new.action = 'checked' then 'task_item_checked' else 'task_item_unchecked' end;
        v_title := case when new.action = 'checked' then 'Пункт отмечен' else 'Отметка пункта снята' end;
        select task_id, title into v_task_id, v_item_title
          from public.task_items where id = new.entity_id;
    elsif new.action = 'updated' and (new.new_data ? 'title' or new.new_data ? 'description') then
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
        v_title := 'Задача архивирована';
    elsif new.action = 'restored' and new.entity_type = 'task' then
        v_type := 'task_restored';
        v_task_id := new.entity_id;
        v_title := 'Задача восстановлена';
    else
        return new;
    end if;

    if new.entity_type = 'project' and new.action in ('archived', 'restored') then
        select name into v_project_name from public.projects where id = new.project_id;
        v_body := format('Проект «%s» %s.', coalesce(v_project_name, 'Без названия'),
            case when new.action = 'archived' then 'архивирован' else 'восстановлен' end);
        for v_recipient in
            select pm.user_id from public.project_members pm
             where pm.project_id = new.project_id and pm.user_id <> v_actor
        loop
            perform private.create_notification(
                v_recipient, new.project_id, null, v_type, v_title, v_body,
                jsonb_build_object('project_id', new.project_id), 'audit:' || new.id::text);
        end loop;
        return new;
    end if;

    if v_task_id is null then
        return new;
    end if;

    select p.name, t.title
      into v_project_name, v_task_title
      from public.tasks t join public.projects p on p.id = t.project_id
     where t.id = v_task_id;
    v_project_name := coalesce(v_project_name, 'Без названия');
    v_task_title := coalesce(v_task_title, 'Без названия');

    if new.action in ('archived', 'restored') and new.entity_type = 'task' then
        v_body := format('Задача «%s» в проекте «%s» %s.', v_task_title, v_project_name,
            case when new.action = 'archived' then 'архивирована' else 'восстановлена' end);
        for v_recipient in
            select tm.user_id from public.task_members tm
             where tm.task_id = v_task_id and tm.user_id <> v_actor
        loop
            perform private.create_notification(
                v_recipient, new.project_id, v_task_id, v_type, v_title, v_body,
                jsonb_build_object('task_id', v_task_id), 'audit:' || new.id::text);
        end loop;
        return new;
    end if;

    select coalesce(nullif(display_name, ''), 'Пользователь') into v_person_name
      from public.profiles where id = v_recipient;
    if new.action = 'access_approved' then
        v_body := format('%s получил доступ к задаче «%s» в проекте «%s».', coalesce(v_person_name, 'Пользователь'), v_task_title, v_project_name);
    elsif new.action = 'access_revoked' then
        v_body := format('У пользователя %s отозван доступ к задаче «%s» в проекте «%s».', coalesce(v_person_name, 'Пользователь'), v_task_title, v_project_name);
    elsif new.action = 'assignee_added' then
        v_body := format('Вы назначены исполнителем задачи «%s» в проекте «%s».', v_task_title, v_project_name);
    elsif new.action = 'assignee_removed' then
        v_body := format('С вас снято назначение в задаче «%s» проекта «%s».', v_task_title, v_project_name);
    elsif new.action in ('checked', 'unchecked') then
        v_body := format('«%s» → задача «%s» → проект «%s».', coalesce(v_item_title, 'Пункт чек-листа'), v_task_title, v_project_name);
    else
        v_body := format('Пункт «%s» изменён в задаче «%s» проекта «%s».', coalesce(v_item_title, 'Пункт чек-листа'), v_task_title, v_project_name);
    end if;

    if new.action in ('checked', 'unchecked', 'updated') then
        for v_recipient in
            select tm.user_id from public.task_members tm
             where tm.task_id = v_task_id and tm.user_id <> v_actor
        loop
            perform private.create_notification(
                v_recipient, new.project_id, v_task_id, v_type, v_title, v_body,
                jsonb_build_object('task_id', v_task_id, 'entity_id', new.entity_id), 'audit:' || new.id::text);
        end loop;
    elsif v_recipient is not null and v_recipient <> v_actor then
        perform private.create_notification(
            v_recipient, new.project_id, v_task_id, v_type, v_title, v_body,
            jsonb_build_object('task_id', v_task_id), 'audit:' || new.id::text);
    end if;
    return new;
end
$$;

-- Project archive/restore is serialized by the project row lock.  Every task
-- update is part of the same transaction and is therefore audited/notified.
create or replace function public.archive_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_archive_at timestamptz := now();
begin
    perform private.lock_project(p_project_id);
    if not private.is_project_admin(p_project_id) then
        raise exception 'only owner/admin can archive the project' using errcode = 'insufficient_privilege';
    end if;
    if not exists (select 1 from public.projects where id = p_project_id and status = 'active') then
        return;
    end if;

    update public.tasks
       set status = 'archived', archived_at = v_archive_at,
           archived_by_project_at = v_archive_at
     where project_id = p_project_id and status <> 'archived';

    update public.projects
       set status = 'archived', archived_at = v_archive_at
     where id = p_project_id and status = 'active';
end
$$;

create or replace function public.archive_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_project_id uuid;
begin
    perform private.require_auth();
    v_project_id := private.task_project_id(p_task_id);
    perform private.lock_project(v_project_id);
    perform private.lock_task(p_task_id);
    if not private.is_project_admin(v_project_id) then
        raise exception 'only owner/admin can archive tasks' using errcode = 'insufficient_privilege';
    end if;
    if not private.project_is_active(v_project_id) then
        raise exception 'project is archived';
    end if;
    update public.tasks
       set status = 'archived', archived_at = now(), archived_by_project_at = null
     where id = p_task_id and status <> 'archived';
end
$$;

create or replace function public.restore_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_project public.projects%rowtype;
    v_user uuid := private.require_auth();
begin
    perform private.lock_project(p_project_id);
    if not private.is_project_admin(p_project_id) then
        raise exception 'project admin role required' using errcode = 'insufficient_privilege';
    end if;
    select * into v_project from public.projects where id = p_project_id;
    if not found then raise exception 'project not found'; end if;
    if v_project.status <> 'archived' then raise exception 'project is not archived'; end if;

    update public.projects set status = 'active', archived_at = null where id = p_project_id;

    update public.tasks t
       set status = private.task_status_from_items(t.id),
           archived_at = null,
           archived_by_project_at = null
     where t.project_id = p_project_id
       and t.status = 'archived'
       and t.archived_by_project_at = v_project.archived_at;
end
$$;

create or replace function public.restore_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_project_id uuid;
    v_task public.tasks%rowtype;
begin
    perform private.require_auth();
    v_project_id := private.task_project_id(p_task_id);
    perform private.lock_project(v_project_id);
    v_task := private.lock_task(p_task_id);
    if not private.is_project_admin(v_project_id) then
        raise exception 'only owner/admin can restore tasks' using errcode = 'insufficient_privilege';
    end if;
    if not private.project_is_active(v_project_id) then
        raise exception 'project is archived';
    end if;
    if v_task.status <> 'archived' then
        return;
    end if;

    update public.tasks
       set status = private.task_status_from_items(p_task_id),
           archived_at = null,
           archived_by_project_at = null
     where id = p_task_id and status = 'archived';
end
$$;

revoke all on function public.restore_task(uuid) from public, anon;
grant execute on function public.restore_task(uuid) to authenticated, service_role;
