-- Global authenticated template library: reuse private Broadcast and its RLS.
-- Statement triggers bound multi-row item reorders/imports to one signal/table.
-- The existing SELECT-only realtime policy still forbids client event injection.
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
    if v_user is null then return false; end if;
    if p_topic = 'templates' then return true; end if;
    if p_topic <> (v_kind || ':' || v_value)
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
    elsif tg_table_name in ('task_templates', 'task_template_items') then
        -- Active templates are a global authenticated library. Never broadcast rows or IDs.
        perform realtime.send(v_payload, 'invalidate', 'templates', true);
        return null;
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
        -- Stage-only clients never join the project's private topic. Send the
        -- same opaque invalidation through each existing stage topic instead.
        for v_recipient in select t.id from public.tasks t where t.project_id=v_project_id loop
            perform realtime.send(v_payload, 'invalidate', 'task:' || v_recipient::text, true);
        end loop;
        for v_recipient in
            select s.user_id from (select pm.user_id from public.project_members pm where pm.project_id=v_project_id
    union select tm.user_id from public.task_members tm join public.tasks t on t.id=tm.task_id
      where t.project_id=v_project_id and tm.is_direct) s where s.user_id is distinct from v_user_id
        loop
            perform realtime.send(v_payload, 'invalidate', 'user:' || v_recipient::text, true);
        end loop;
    elsif tg_table_name in ('tasks', 'task_items') and v_task_id is not null then
        for v_recipient in
            select s.user_id from (select pm.user_id from public.project_members pm where pm.project_id=v_project_id
    union select tm.user_id from public.task_members tm where tm.task_id=v_task_id and tm.is_direct) s
    where private.has_task_access(v_task_id,s.user_id) and s.user_id is distinct from v_user_id
        loop
            perform realtime.send(v_payload, 'invalidate', 'user:' || v_recipient::text, true);
        end loop;
    end if;
    return null;
end;
$$;
revoke all on function private.can_receive_realtime_topic(text) from public, anon, service_role;
grant execute on function private.can_receive_realtime_topic(text) to authenticated;
revoke all on function private.broadcast_application_invalidation() from public, anon, authenticated, service_role;

create trigger trg_task_templates_broadcast_invalidation
    after insert or update or delete on public.task_templates
    for each statement execute function private.broadcast_application_invalidation();
create trigger trg_task_template_items_broadcast_invalidation
    after insert or update or delete on public.task_template_items
    for each statement execute function private.broadcast_application_invalidation();
