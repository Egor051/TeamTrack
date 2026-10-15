-- Absolute checklist deadlines. Existing rows have no deadline.
alter table public.task_items add column deadline_at timestamptz;
create index task_items_active_deadline on public.task_items(deadline_at, id)
    where deadline_at is not null and not is_archived and percentage < 100;

-- One account read model, protected by the same RLS as its source tables.
create view public.checklist_overview with (security_invoker = true) as
select i.id, i.task_id, t.project_id, i.percentage, i.is_completed, i.comment,
       i.deadline_at, i.sync_version
from public.task_items i
join public.tasks t on t.id = i.task_id
join public.projects p on p.id = t.project_id
where not i.is_archived and t.status <> 'archived' and p.status = 'active';
revoke all on public.checklist_overview from public, anon, authenticated;
grant select on public.checklist_overview to authenticated;

-- State rows serialize the scheduler and item triggers. They are never exposed
-- to clients. Event numbers also distinguish later, legitimate reopenings.
create table private.checklist_deadline_state (
    item_id uuid primary key references public.task_items(id) on delete cascade,
    state text not null default 'normal'
        check (state in ('normal', 'urgent', 'overdue', 'completed', 'inactive')),
    event_number bigint not null default 0,
    next_transition_at timestamptz
);
create index checklist_deadline_next_transition
    on private.checklist_deadline_state(next_transition_at, item_id)
    where next_transition_at is not null;
alter table private.checklist_deadline_state enable row level security;
revoke all on private.checklist_deadline_state from public, anon, authenticated, service_role;

create function private.checklist_deadline_status(p_deadline timestamptz, p_percentage integer,
    p_inactive boolean, p_now timestamptz)
returns text language sql immutable set search_path = '' as $$
    select case when p_deadline is null or p_inactive then 'inactive'
        when p_percentage = 100 then 'completed'
        when p_now >= p_deadline then 'overdue'
        when p_now >= p_deadline - interval '12 hours' then 'urgent'
        else 'normal' end;
$$;

create function private.emit_checklist_deadline_event(p_item_id uuid, p_event text,
    p_previous_deadline timestamptz default null, p_actor uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
    v_item public.task_items%rowtype;
    v_project uuid;
    v_project_name text;
    v_task_name text;
    v_number bigint;
    v_audit bigint;
    v_title text;
    v_data jsonb;
    v_recipient uuid;
begin
    select * into v_item from public.task_items where id = p_item_id;
    if not found then return; end if;
    select t.project_id, t.title, p.name into v_project, v_task_name, v_project_name
      from public.tasks t join public.projects p on p.id = t.project_id where t.id = v_item.task_id;
    update private.checklist_deadline_state set event_number = event_number + 1
      where item_id = p_item_id returning event_number into v_number;
    v_title := case p_event
      when 'set' then 'Установлен дедлайн'
      when 'changed' then 'Дедлайн изменён'
      when 'removed' then 'Дедлайн удалён'
      when 'urgent' then 'Горящий дедлайн'
      when 'overdue' then 'Просрочен дедлайн'
      when 'completed' then 'Чек-лист с предупреждением выполнен'
      when 'reopened_urgent' then 'Снова горящий дедлайн'
      when 'reopened_overdue' then 'Снова просрочен дедлайн'
      else 'Состояние дедлайна изменено' end;
    v_data := pg_catalog.jsonb_build_object('task_id', v_item.task_id,
      'entity_id', p_item_id, 'item_id', p_item_id, 'deadline_event', p_event,
      'deadline_at', v_item.deadline_at, 'previous_deadline_at', p_previous_deadline,
      'title', v_item.title, 'task_title', v_task_name, 'project_name', v_project_name,
      'event_number', v_number);
    -- The existing generic audit notifier ignores this entity type; the
    -- deadline event owns its single notification fanout below.
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
      values (v_project, p_actor, 'updated', 'task_item_deadline', p_item_id,
        pg_catalog.jsonb_build_object('deadline_at', p_previous_deadline), v_data)
      returning id into v_audit;
    for v_recipient in select pm.user_id from public.project_members pm
      where pm.project_id = v_project and private.has_task_access(v_item.task_id, pm.user_id)
    loop
      perform private.create_notification(v_recipient, v_project, v_item.task_id, 'task_item_changed',
        v_title, pg_catalog.format('Чек-лист «%s» → этап «%s» → проект «%s». %s',
          v_item.title, v_task_name, v_project_name,
          case when v_item.deadline_at is null then 'Дедлайн удалён.'
            else 'Срок: ' || pg_catalog.to_char(v_item.deadline_at at time zone 'UTC', 'DD.MM.YYYY HH24:MI') || ' UTC.' end),
        v_data, 'deadline:audit:' || v_audit::text);
    end loop;
end;
$$;

create function private.refresh_checklist_deadline(p_item_id uuid, p_now timestamptz default now(),
    p_actor uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
    v_previous text;
    v_next text;
    v_deadline timestamptz;
    v_percentage integer;
    v_inactive boolean;
begin
    select state into v_previous from private.checklist_deadline_state where item_id = p_item_id for update;
    if not found then return; end if;
    -- Never take item/parent locks after a state lock: item mutations already
    -- hold their normal project -> task -> item locks before entering here.
    select i.deadline_at, i.percentage, i.is_archived or t.status = 'archived' or p.status <> 'active'
      into v_deadline, v_percentage, v_inactive from public.task_items i
      join public.tasks t on t.id = i.task_id join public.projects p on p.id = t.project_id
      where i.id = p_item_id;
    if not found then return; end if;
    v_next := private.checklist_deadline_status(v_deadline, v_percentage, v_inactive, p_now);
    update private.checklist_deadline_state set state = v_next,
      next_transition_at = case v_next when 'normal' then v_deadline - interval '12 hours'
        when 'urgent' then v_deadline else null end where item_id = p_item_id;
    if v_previous is distinct from v_next then
      if v_next in ('urgent', 'overdue') then
        perform private.emit_checklist_deadline_event(p_item_id,
          case when v_previous = 'completed' then 'reopened_' || v_next else v_next end, v_deadline, p_actor);
      elsif v_next = 'completed' and v_previous in ('urgent', 'overdue') then
        perform private.emit_checklist_deadline_event(p_item_id, 'completed', v_deadline, p_actor);
      end if;
    end if;
end;
$$;

create function private.checklist_deadline_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if tg_op = 'INSERT' and new.deadline_at is null then return new; end if;
    if tg_op = 'UPDATE' and new.deadline_at is null and old.deadline_at is null then return new; end if;
    insert into private.checklist_deadline_state(item_id) values (new.id) on conflict do nothing;
    -- Lock before emitting or comparing so concurrent cron workers cannot
    -- observe half of a deadline change. No scheduled payload survives a move.
    perform 1 from private.checklist_deadline_state where item_id = new.id for update;
    if tg_op = 'INSERT' or new.deadline_at is distinct from old.deadline_at then
      update private.checklist_deadline_state set state = 'normal' where item_id = new.id;
      perform private.emit_checklist_deadline_event(new.id,
        case when new.deadline_at is null then 'removed' when tg_op = 'INSERT' or old.deadline_at is null then 'set' else 'changed' end,
        case when tg_op = 'UPDATE' then old.deadline_at else null end, auth.uid());
    end if;
    perform private.refresh_checklist_deadline(new.id, pg_catalog.now(), auth.uid());
    return new;
end;
$$;
create trigger trg_task_item_deadline_changed
after insert or update of deadline_at, percentage, is_archived on public.task_items
for each row execute function private.checklist_deadline_changed();

-- Lock parents before state, matching mutation RPCs. Notification inserts take
-- FK key locks on these parents too; locking state first could deadlock with
-- an archive/delete/deadline edit that already holds its parent lock.
create function private.process_checklist_deadlines(p_limit integer default 1000)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_row record; v_count integer := 0;
begin
    for v_row in select s.item_id, t.id as task_id, t.project_id
      from private.checklist_deadline_state s join public.task_items i on i.id = s.item_id
      join public.tasks t on t.id = i.task_id
      where s.next_transition_at <= pg_catalog.now() order by s.next_transition_at, s.item_id
      limit greatest(1, least(p_limit, 10000))
    loop
      perform 1 from public.projects where id = v_row.project_id for update skip locked;
      if not found then continue; end if;
      perform 1 from public.tasks where id = v_row.task_id for update skip locked;
      if not found then continue; end if;
      perform 1 from private.checklist_deadline_state where item_id = v_row.item_id
        and next_transition_at <= pg_catalog.now() for update skip locked;
      if not found then continue; end if;
      perform private.refresh_checklist_deadline(v_row.item_id);
      v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

-- Use the existing permission/lock hierarchy and a compare-and-set against the
-- displayed item. Deadline edits are online actions, like checklist structure
-- edits; offline progress/comment operations retain their existing protocol.
create function public.set_task_item_deadline(p_task_item_id uuid, p_deadline_at timestamptz default null,
    p_expected_version bigint default null)
returns public.task_items language plpgsql security definer set search_path = '' as $$
declare
    v_user uuid := private.require_auth(); v_task_id uuid; v_project_id uuid;
    v_project public.projects%rowtype; v_task public.tasks%rowtype;
    v_item public.task_items%rowtype; v_role public.project_role;
begin
    select task_id into v_task_id from public.task_items where id = p_task_item_id;
    if not found then raise exception 'no access to task item' using errcode = '42501'; end if;
    v_project_id := private.task_project_id(v_task_id);
    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(v_task_id);
    v_role := private.lock_task_role(v_task_id, v_project_id, v_user);
    select * into v_item from public.task_items where id = p_task_item_id for update;
    if v_role is null or v_role not in ('owner', 'admin', 'member') then
      raise exception 'no access to task item' using errcode = '42501'; end if;
    if v_item.is_archived or v_task.status = 'archived' or v_project.status <> 'active' then
      raise exception 'task item is archived' using errcode = '42501'; end if;
    if p_expected_version is null or p_expected_version <> v_item.sync_version then
      -- A business conflict must not use serialization_failure: PostgREST
      -- retries that SQLSTATE internally. PT409 is a terminal HTTP conflict.
      raise exception 'Данные чек-листа изменились. Обновите этап и повторите действие.' using errcode = 'PT409'; end if;
    if v_item.deadline_at is not distinct from p_deadline_at then return v_item; end if;
    if p_deadline_at is not null and (not pg_catalog.isfinite(p_deadline_at) or p_deadline_at <= pg_catalog.clock_timestamp()) then
      raise exception 'Дедлайн должен быть в будущем.' using errcode = '22023'; end if;
    update public.task_items set deadline_at = p_deadline_at where id = p_task_item_id returning * into v_item;
    return v_item;
end;
$$;

-- Deadline changes are part of the same versioned pull feed. Older queued
-- progress/comment edits meet a conflict instead of overwriting new values.
create or replace function private.bump_task_item_sync_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if pg_catalog.current_setting('tasktrace.force_sync_version_bump', true) = 'on'
       or new.percentage is distinct from old.percentage
       or new.is_completed is distinct from old.is_completed
       or new.comment is distinct from old.comment
       or new.is_archived is distinct from old.is_archived
       or new.deadline_at is distinct from old.deadline_at then
      new.sync_version := old.sync_version + 1;
    else new.sync_version := old.sync_version; end if;
    return new;
end;
$$;

-- Recompute after obtaining the parent lock, including callers outside RPCs.
create or replace function private.recalculate_task_status(p_task_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_status public.task_status;
begin
    perform 1 from public.tasks where id = p_task_id for update;
    v_status := private.task_status_from_items(p_task_id);
    update public.tasks set status = v_status, archived_at = null, archived_by_project_at = null
      where id = p_task_id and status <> 'archived' and status is distinct from v_status;
end;
$$;

revoke all on function private.checklist_deadline_status(timestamptz, integer, boolean, timestamptz),
  private.emit_checklist_deadline_event(uuid, text, timestamptz, uuid),
  private.refresh_checklist_deadline(uuid, timestamptz, uuid), private.checklist_deadline_changed(),
  private.process_checklist_deadlines(integer) from public, anon, authenticated, service_role;
revoke all on function public.set_task_item_deadline(uuid, timestamptz, bigint) from public, anon, service_role;
grant execute on function public.set_task_item_deadline(uuid, timestamptz, bigint) to authenticated;

create function private.refresh_parent_checklist_deadlines()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
    if (old.status::text = 'archived') = (new.status::text = 'archived') then return new; end if;
    for v_id in select i.id from public.task_items i join public.tasks t on t.id = i.task_id
      where i.deadline_at is not null and
        ((tg_table_name = 'tasks' and t.id = new.id) or (tg_table_name = 'projects' and t.project_id = new.id))
      order by i.id
    loop
      perform private.refresh_checklist_deadline(v_id, pg_catalog.now(), auth.uid());
    end loop;
    return new;
end;
$$;
revoke all on function private.refresh_parent_checklist_deadlines() from public, anon, authenticated, service_role;
create trigger trg_task_parent_deadlines after update of status on public.tasks
  for each row execute function private.refresh_parent_checklist_deadlines();
create trigger trg_project_parent_deadlines after update of status on public.projects
  for each row execute function private.refresh_parent_checklist_deadlines();

-- Invalidate every authorized member overview, including unassigned stages.
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
    elsif tg_table_name in ('tasks', 'task_items') and v_task_id is not null then
        for v_recipient in
            select pm.user_id
              from public.project_members pm
             where pm.project_id = v_project_id
               and private.has_task_access(v_task_id, pm.user_id)
               and pm.user_id is distinct from v_user_id
        loop
            perform realtime.send(v_payload, 'invalidate', 'user:' || v_recipient::text, true);
        end loop;
    end if;
    return null;
end;
$$;

revoke all on function private.broadcast_application_invalidation()
    from public, anon, authenticated, service_role;
