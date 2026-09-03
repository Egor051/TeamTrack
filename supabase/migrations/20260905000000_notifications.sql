-- MVP notifications: server-generated rows from immutable audit events.
create type public.notification_type as enum (
  'task_member_added', 'task_member_removed', 'task_assigned', 'task_unassigned',
  'task_item_changed', 'task_item_checked', 'task_item_unchecked'
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  type public.notification_type not null,
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  dedupe_key text not null,
  constraint notifications_read_consistency check ((is_read and read_at is not null) or (not is_read and read_at is null))
);
create unique index ux_notifications_dedupe on public.notifications(user_id, dedupe_key);
create index idx_notifications_user_created on public.notifications(user_id, created_at desc);
create index idx_notifications_user_read_created on public.notifications(user_id, is_read, created_at desc);

alter table public.notifications enable row level security;
create policy notifications_select_own on public.notifications for select to authenticated using (user_id = auth.uid());
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.notifications set is_read = true, read_at = coalesce(read_at, now())
  where id = p_notification_id and user_id = auth.uid();
end $$;
create or replace function public.mark_all_notifications_read()
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.notifications set is_read = true, read_at = coalesce(read_at, now())
  where user_id = auth.uid() and not is_read;
end $$;
revoke all on function public.mark_notification_read(uuid), public.mark_all_notifications_read() from public, anon;
grant execute on function public.mark_notification_read(uuid), public.mark_all_notifications_read() to authenticated, service_role;

create or replace function private.create_notification(
  p_user_id uuid, p_project_id uuid, p_task_id uuid, p_type public.notification_type,
  p_title text, p_body text, p_data jsonb, p_dedupe_key text
) returns void language sql security definer set search_path = public, private as $$
  insert into public.notifications(user_id, project_id, task_id, type, title, body, data, dedupe_key)
  values (p_user_id, p_project_id, p_task_id, p_type, p_title, p_body, coalesce(p_data, '{}'::jsonb), p_dedupe_key)
  on conflict (user_id, dedupe_key) do nothing;
$$;

create or replace function private.audit_to_notification()
returns trigger language plpgsql security definer set search_path = public, private as $$
declare
  v_task_id uuid := (new.new_data->>'task_id')::uuid;
  v_type public.notification_type;
  v_title text; v_body text; v_recipient uuid;
begin
  if new.action = 'access_approved' then
    v_type := 'task_member_added'; v_recipient := new.entity_id;
    v_title := 'Доступ к задаче предоставлен'; v_body := 'Вас добавили в задачу';
    v_task_id := (new.new_data->>'task_id')::uuid;
  elsif new.action = 'access_revoked' then
    v_type := 'task_member_removed'; v_recipient := new.entity_id;
    v_title := 'Доступ к задаче отозван'; v_body := 'Ваш доступ к задаче был отозван';
    v_task_id := (new.new_data->>'task_id')::uuid;
  elsif new.action = 'assignee_added' then
    v_type := 'task_assigned'; v_recipient := new.entity_id;
    v_title := 'Вас назначили ответственным'; v_body := 'Вас назначили ответственным за задачу';
    v_task_id := (new.new_data->>'task_id')::uuid;
  elsif new.action = 'assignee_removed' then
    v_type := 'task_unassigned'; v_recipient := new.entity_id;
    v_title := 'Назначение снято'; v_body := 'Вас больше не назначили ответственным за задачу';
    v_task_id := (new.new_data->>'task_id')::uuid;
  elsif new.action in ('checked', 'unchecked') then
    v_type := case when new.action = 'checked' then 'task_item_checked' else 'task_item_unchecked' end;
    v_title := case when new.action = 'checked' then 'Пункт отмечен' else 'Отметка пункта снята' end;
    v_body := 'Изменилось состояние пункта чек-листа';
    select task_id into v_task_id from public.task_items where id = new.entity_id;
  elsif new.action = 'updated' and (new.new_data ? 'title' or new.new_data ? 'description') then
    v_type := 'task_item_changed'; v_title := 'Изменён пункт чек-листа'; v_body := 'Изменился текст пункта чек-листа';
    select task_id into v_task_id from public.task_items where id = new.entity_id;
  else return new;
  end if;
  if v_task_id is null then return new; end if;
  if new.action in ('checked','unchecked','updated') then
    for v_recipient in select tm.user_id from public.task_members tm where tm.task_id = v_task_id and tm.user_id <> coalesce(new.user_id, '00000000-0000-0000-0000-000000000000') loop
      perform private.create_notification(v_recipient, new.project_id, v_task_id, v_type, v_title, v_body,
        jsonb_build_object('task_id', v_task_id, 'entity_id', new.entity_id), 'audit:' || new.id::text);
    end loop;
  else
    if v_recipient is not null and v_recipient <> coalesce(new.user_id, '00000000-0000-0000-0000-000000000000') then
      perform private.create_notification(v_recipient, new.project_id, v_task_id, v_type, v_title, v_body,
        jsonb_build_object('task_id', v_task_id), 'audit:' || new.id::text);
    end if;
  end if;
  return new;
end $$;
create trigger trg_audit_log_notifications after insert on public.audit_log for each row execute function private.audit_to_notification();

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;
