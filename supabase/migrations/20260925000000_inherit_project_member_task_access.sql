-- Project membership is the effective access grant for every stage and its
-- checklist.  task_members remains as legacy/explicit task metadata for audit
-- and compatibility, but it must never be required for a project member to
-- read or use a stage.

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
    select exists (
        select 1
          from public.tasks t
          join public.project_members pm
            on pm.project_id = t.project_id
           and pm.user_id = p_user_id
         where t.id = p_task_id
    );
$$;

comment on function private.has_task_access(uuid, uuid) is
    'Effective stage access is inherited from project_members. task_members is not required.';

comment on table public.task_members is
    'Optional explicit task access metadata retained for compatibility and audit. Effective stage/checklist access is inherited from project_members.';

-- Assignments follow the same inherited access model. Project admins may
-- assign any project member without first creating a task_members row.
create or replace function public.add_task_assignee(p_task_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project_id uuid := private.task_project_id(p_task_id);
    v_task public.tasks%rowtype;
begin
    perform private.lock_project(v_project_id);
    v_task := private.lock_task(p_task_id);
    if not private.is_project_admin(v_project_id) then
        raise exception 'only owner/admin can manage assignees' using errcode = 'insufficient_privilege';
    end if;
    if v_task.status = 'archived' or not private.project_is_active(v_project_id) then
        raise exception 'task is archived';
    end if;
    if not private.is_project_member(v_project_id, p_user_id) then
        raise exception 'assignee must be a project member';
    end if;
    if exists (select 1 from public.task_assignees where task_id = p_task_id and user_id = p_user_id) then
        return;
    end if;

    insert into public.task_assignees(task_id, user_id, assigned_by)
    values (p_task_id, p_user_id, v_user);
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, new_data)
    values (v_project_id, v_user, 'assignee_added', 'task_assignee', p_user_id,
            jsonb_build_object('task_id', p_task_id, 'user_id', p_user_id));
end
$$;

-- Notifications follow effective project access as well. Explicit task rows
-- are not a complete recipient list once project membership grants access.
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
    v_change_summary text;
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
    elsif new.action = 'updated'
      and new.entity_type = 'task_item'
      and (new.new_data ? 'title' or new.new_data ? 'description'
        or new.new_data ? 'position' or new.new_data ? 'percentage'
        or new.new_data ? 'comment' or new.new_data ? 'is_completed') then
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
            perform private.create_notification(v_recipient, new.project_id, null, v_type, v_title, v_body,
                jsonb_build_object('project_id', new.project_id), 'audit:' || new.id::text);
        end loop;
        return new;
    end if;

    if v_task_id is null then return new; end if;
    select p.name, t.title into v_project_name, v_task_title
      from public.tasks t join public.projects p on p.id = t.project_id
     where t.id = v_task_id;
    v_project_name := coalesce(v_project_name, 'Без названия');
    v_task_title := coalesce(v_task_title, 'Без названия');

    if new.action in ('archived', 'restored') and new.entity_type = 'task' then
        v_body := format('Задача «%s» в проекте «%s» %s.', v_task_title, v_project_name,
            case when new.action = 'archived' then 'архивирована' else 'восстановлена' end);
        for v_recipient in
            select pm.user_id from public.project_members pm
             where pm.project_id = new.project_id and pm.user_id <> v_actor
        loop
            perform private.create_notification(v_recipient, new.project_id, v_task_id, v_type, v_title, v_body,
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
        v_change_summary := concat_ws(', ',
            case when new.new_data ? 'title' then 'название' end,
            case when new.new_data ? 'description' then 'описание' end,
            case when new.new_data ? 'position' then 'порядок' end,
            case when new.new_data ? 'percentage' then format('прогресс %s%%', new.new_data->>'percentage') end,
            case when new.new_data ? 'comment' then 'комментарий' end,
            case when new.new_data ? 'is_completed' and not (new.new_data ? 'percentage') then 'состояние' end);
        v_body := format('Пункт «%s» изменён (%s) в задаче «%s» проекта «%s».',
            coalesce(v_item_title, 'Пункт чек-листа'), coalesce(v_change_summary, 'данные'), v_task_title, v_project_name);
    end if;

    if new.action in ('checked', 'unchecked', 'updated') then
        for v_recipient in
            select pm.user_id from public.project_members pm
             where pm.project_id = new.project_id and pm.user_id <> v_actor
        loop
            perform private.create_notification(v_recipient, new.project_id, v_task_id, v_type, v_title, v_body,
                jsonb_build_object('task_id', v_task_id, 'entity_id', new.entity_id), 'audit:' || new.id::text);
        end loop;
    elsif v_recipient is not null and v_recipient <> v_actor then
        perform private.create_notification(v_recipient, new.project_id, v_task_id, v_type, v_title, v_body,
            jsonb_build_object('task_id', v_task_id), 'audit:' || new.id::text);
    end if;
    return new;
end
$$;
