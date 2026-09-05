-- Contextual notification text. Keeps ids and dedupe semantics unchanged.
create or replace function private.audit_to_notification()
returns trigger language plpgsql security definer set search_path = public, private as $$
declare
  v_task_id uuid := nullif(new.new_data->>'task_id', '')::uuid;
  v_type public.notification_type;
  v_title text;
  v_body text;
  v_recipient uuid;
  v_project_name text;
  v_task_title text;
  v_item_title text;
  v_person_name text;
begin
  if new.action = 'access_approved' then
    v_type := 'task_member_added'; v_recipient := new.entity_id; v_title := 'Доступ к задаче предоставлен';
  elsif new.action = 'access_revoked' then
    v_type := 'task_member_removed'; v_recipient := new.entity_id; v_title := 'Доступ к задаче отозван';
  elsif new.action = 'assignee_added' then
    v_type := 'task_assigned'; v_recipient := new.entity_id; v_title := 'Вас назначили исполнителем';
  elsif new.action = 'assignee_removed' then
    v_type := 'task_unassigned'; v_recipient := new.entity_id; v_title := 'Назначение снято';
  elsif new.action in ('checked', 'unchecked') then
    v_type := case when new.action = 'checked' then 'task_item_checked' else 'task_item_unchecked' end;
    v_title := case when new.action = 'checked' then 'Пункт отмечен' else 'Отметка пункта снята' end;
    select task_id, title into v_task_id, v_item_title from public.task_items where id = new.entity_id;
  elsif new.action = 'updated' and (new.new_data ? 'title' or new.new_data ? 'description') then
    v_type := 'task_item_changed'; v_title := 'Изменён пункт чек-листа';
    select task_id, title into v_task_id, v_item_title from public.task_items where id = new.entity_id;
  else return new;
  end if;

  if v_task_id is null then return new; end if;
  select p.name, t.title into v_project_name, v_task_title
    from public.tasks t join public.projects p on p.id = t.project_id
   where t.id = v_task_id;
  v_project_name := coalesce(v_project_name, 'Без названия');
  v_task_title := coalesce(v_task_title, 'Без названия');
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

  if new.action in ('checked','unchecked','updated') then
    for v_recipient in select tm.user_id from public.task_members tm where tm.task_id = v_task_id and tm.user_id <> coalesce(new.user_id, '00000000-0000-0000-0000-000000000000') loop
      perform private.create_notification(v_recipient, new.project_id, v_task_id, v_type, v_title, v_body,
        jsonb_build_object('task_id', v_task_id, 'entity_id', new.entity_id), 'audit:' || new.id::text);
    end loop;
  elsif v_recipient is not null and v_recipient <> coalesce(new.user_id, '00000000-0000-0000-0000-000000000000') then
    perform private.create_notification(v_recipient, new.project_id, v_task_id, v_type, v_title, v_body,
      jsonb_build_object('task_id', v_task_id), 'audit:' || new.id::text);
  end if;
  return new;
end $$;

revoke all on function private.audit_to_notification() from public, anon, authenticated;
