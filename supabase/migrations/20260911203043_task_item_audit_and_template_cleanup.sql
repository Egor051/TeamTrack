create or replace function public.audit_to_notification()
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
    v_actor uuid := coalesce(new.user_id, '00000000-0000-0000-0000-000000000000'::uuid);
    v_changed_fields text;
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
      and (
          new.new_data ? 'percentage'
          or new.new_data ? 'comment'
          or new.new_data ? 'description'
          or new.new_data ? 'position'
          or new.new_data ? 'title'
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
        select string_agg(case key
                   when 'percentage' then 'процент выполнения'
                   when 'comment' then 'комментарий'
                   when 'description' then 'описание'
                   when 'position' then 'положение'
                   when 'title' then 'название'
                   else key end, ', ' order by key)
          into v_changed_fields
          from jsonb_object_keys(coalesce(new.new_data, '{}'::jsonb)) as fields(key)
         where key in ('percentage', 'comment', 'description', 'position', 'title');

        v_body := format('Пункт «%s» изменён в задаче «%s» проекта «%s». Изменено: %s.',
            coalesce(v_item_title, 'Пункт чек-листа'), v_task_title, v_project_name,
            coalesce(v_changed_fields, 'данные пункта'));
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
returns table (
    task_item_id uuid,
    user_id uuid,
    display_name text,
    changed_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
    with ranked as (
        select
            al.entity_id as task_item_id,
            al.user_id,
            al.created_at as changed_at,
            row_number() over (
                partition by al.entity_id
                order by al.created_at desc, al.id desc
            ) as rn
        from public.audit_log al
        join public.task_items ti on ti.id = al.entity_id
        where al.entity_type = 'task_item'
          and ti.task_id = p_task_id
          and not (
              al.action = 'updated'
              and coalesce(al.old_data, '{}'::jsonb) ? 'title'
              and coalesce(al.new_data, '{}'::jsonb) ? 'title'
              and (coalesce(al.old_data, '{}'::jsonb) - 'title') = (coalesce(al.new_data, '{}'::jsonb) - 'title')
          )
    )
    select r.task_item_id,
           r.user_id,
           coalesce(nullif(p.display_name, ''), 'Пользователь') as display_name,
           r.changed_at
      from ranked r
      left join public.profiles p on p.id = r.user_id
     where r.rn = 1
     order by r.changed_at desc, r.task_item_id;
$$;

grant execute on function public.list_task_item_last_editors(uuid) to authenticated, service_role;

-- Remove legacy archived test templates. Active templates are untouched.
delete from public.task_templates
 where archived_at is not null;;
