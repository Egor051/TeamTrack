-- Reconcile the hosted historical implementation with the current canonical
-- TaskTrace functions without replaying the original migration's data cleanup.

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
      and (
          new.new_data ? 'title'
          or new.new_data ? 'description'
          or new.new_data ? 'position'
          or new.new_data ? 'percentage'
          or new.new_data ? 'comment'
          or new.new_data ? 'is_completed'
      ) then
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
        v_change_summary := concat_ws(', ',
            case when new.new_data ? 'title' then 'название' end,
            case when new.new_data ? 'description' then 'описание' end,
            case when new.new_data ? 'position' then 'порядок' end,
            case when new.new_data ? 'percentage' then format('прогресс %s%%', new.new_data->>'percentage') end,
            case when new.new_data ? 'comment' then 'комментарий' end,
            case when new.new_data ? 'is_completed' and not (new.new_data ? 'percentage') then 'состояние' end
        );
        v_body := format('Пункт «%s» изменён (%s) в задаче «%s» проекта «%s».',
            coalesce(v_item_title, 'Пункт чек-листа'), coalesce(v_change_summary, 'данные'), v_task_title, v_project_name);
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

create or replace function public.list_task_item_last_editors(p_task_id uuid)
returns table(
    task_item_id uuid,
    user_id uuid,
    display_name text,
    changed_at timestamptz
)
language sql
stable
security definer
set search_path = private, public
as $$
    with task_context as (
        select t.id, t.project_id
          from public.tasks t
         where t.id = p_task_id
           and private.has_task_access(p_task_id)
    ), item_ids as (
        select ti.id
          from public.task_items ti
          join task_context tc on tc.id = ti.task_id
    ), ranked as (
        select a.entity_id as task_item_id,
               a.user_id,
               a.created_at as changed_at,
               row_number() over (
                   partition by a.entity_id
                   order by a.created_at desc, a.id desc
               ) as row_number
          from public.audit_log a
          join item_ids i on i.id = a.entity_id
          join task_context tc on tc.project_id = a.project_id
         where a.entity_type = 'task_item'
           and not (
               a.action = 'updated'
               and a.new_data ? 'title'
               and (a.new_data - 'title') = '{}'::jsonb
           )
    )
    select r.task_item_id,
           r.user_id,
           coalesce(nullif(p.display_name, ''), 'Пользователь') as display_name,
           r.changed_at
      from ranked r
      left join public.profiles p on p.id = r.user_id
     where r.row_number = 1
$$;

revoke all on function public.list_task_item_last_editors(uuid) from public, anon;
grant execute on function public.list_task_item_last_editors(uuid) to authenticated, service_role;

;
