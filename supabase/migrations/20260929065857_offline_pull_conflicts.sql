-- Phase 5: checklist-only optimistic concurrency and ordered pull feed.
alter table public.task_items
    add column sync_version bigint not null default 1
    check (sync_version > 0);

-- Serialize item statements before they take row locks. This makes change
-- cursor allocation follow commit order, including concurrent transactions.
create function private.serialize_task_item_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    perform pg_catalog.pg_advisory_xact_lock(29175, 5);
    return null;
end;
$$;
revoke all on function private.serialize_task_item_sync() from public, anon, authenticated;
create trigger trg_00_task_item_sync_order
before insert or update or delete on public.task_items
for each statement execute function private.serialize_task_item_sync();

create function private.bump_task_item_sync_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if pg_catalog.current_setting('tasktrace.force_sync_version_bump', true) = 'on'
       or new.percentage is distinct from old.percentage
       or new.is_completed is distinct from old.is_completed
       or new.comment is distinct from old.comment
       or new.is_archived is distinct from old.is_archived then
        new.sync_version := old.sync_version + 1;
    else
        new.sync_version := old.sync_version;
    end if;
    return new;
end;
$$;
revoke all on function private.bump_task_item_sync_version() from public, anon, authenticated;
create trigger trg_task_item_sync_version
before update on public.task_items
for each row execute function private.bump_task_item_sync_version();

create table private.task_item_sync_changes (
    cursor bigint generated always as identity primary key,
    project_id uuid not null,
    task_id uuid not null,
    task_item_id uuid not null,
    change_type text not null check (change_type in ('upsert', 'delete')),
    item jsonb,
    created_at timestamptz not null default now()
);
create index task_item_sync_changes_task_cursor on private.task_item_sync_changes(task_id, cursor);
alter table private.task_item_sync_changes enable row level security;
revoke all on private.task_item_sync_changes from public, anon, authenticated;
revoke all on sequence private.task_item_sync_changes_cursor_seq from public, anon, authenticated;

create function private.record_task_item_sync_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
    v_item public.task_items%rowtype;
    v_project_id uuid;
begin
    if tg_op = 'UPDATE' and new.percentage is not distinct from old.percentage
       and new.is_completed is not distinct from old.is_completed
       and new.comment is not distinct from old.comment
       and new.is_archived is not distinct from old.is_archived
       and new.sync_version is not distinct from old.sync_version then
        return new;
    end if;
    if tg_op = 'DELETE' then v_item := old; else v_item := new; end if;
    select project_id into v_project_id from public.tasks where id = v_item.task_id;
    -- A parent cascade is covered by the existing project/task cache denial path.
    if v_project_id is null then return null; end if;
    insert into private.task_item_sync_changes(project_id, task_id, task_item_id, change_type, item)
    values (v_project_id, v_item.task_id, v_item.id,
        case when tg_op = 'DELETE' then 'delete' else 'upsert' end,
        case when tg_op = 'DELETE' then null else pg_catalog.to_jsonb(new) end);
    return null;
end;
$$;
revoke all on function private.record_task_item_sync_change() from public, anon, authenticated;
create trigger trg_task_item_sync_change
after insert or update or delete on public.task_items
for each row execute function private.record_task_item_sync_change();

create function public.get_task_item_sync_cursor()
returns bigint language plpgsql security definer set search_path = '' as $$
begin
    perform private.require_auth();
    perform pg_catalog.pg_advisory_xact_lock(29175, 5);
    return coalesce((select max(cursor) from private.task_item_sync_changes), 0);
end;
$$;

-- Page through the global ordered log, then filter its snapshots under the
-- caller's current task membership. Advancing past hidden rows is safe.
create function public.pull_task_item_changes(p_after_cursor bigint, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_user uuid := private.require_auth();
    v_rows jsonb;
    v_cursor bigint;
    v_count integer;
begin
    if p_after_cursor is null or p_after_cursor < 0 or p_limit is null or p_limit < 1 or p_limit > 500 then
        raise exception 'invalid sync cursor or page size' using errcode = '22023';
    end if;
    with page as materialized (
        select cursor, task_id, task_item_id, change_type, item
        from private.task_item_sync_changes
        where cursor > p_after_cursor order by cursor limit p_limit
    ), visible as (
        select cursor, task_id, task_item_id, change_type, item from page
        where private.has_task_access(task_id, v_user)
    )
    select coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'cursor', cursor, 'task_id', task_id, 'task_item_id', task_item_id,
             'change_type', change_type, 'item', item) order by cursor) from visible), '[]'::jsonb),
           coalesce((select max(cursor) from page), p_after_cursor),
           (select count(*) from page)
      into v_rows, v_cursor, v_count;
    return pg_catalog.jsonb_build_object('changes', v_rows, 'next_cursor', v_cursor, 'has_more', v_count = p_limit);
end;
$$;

-- The receipt is claimed before any item lock. A completed duplicate returns
-- its saved success even if the caller's old expected_version is now stale.
create function private.apply_task_item_operation_v2(
    p_operation_id uuid, p_task_item_id uuid, p_expected_version bigint,
    p_kind text, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_user uuid := private.require_auth();
    v_claimed boolean;
    v_saved jsonb;
    v_task_id uuid;
    v_project_id uuid;
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_role public.project_role;
    v_item public.task_items%rowtype;
    v_result jsonb;
begin
    if p_expected_version is null or p_expected_version < 1 then
        raise exception 'expected_version is required' using errcode = '22023';
    end if;
    if p_kind not in ('set_task_item_state', 'set_task_item_percentage', 'set_task_item_comment') then
        raise exception 'invalid operation type' using errcode = '22023';
    end if;
    select claimed, saved_result into v_claimed, v_saved
      from private.claim_client_operation(p_operation_id, p_kind || '_v2', p_task_item_id, p_payload);
    if not v_claimed then return v_saved; end if;

    select task_id into v_task_id from public.task_items where id = p_task_item_id;
    if not found then raise exception 'task item not found' using errcode = '42501'; end if;
    v_project_id := private.task_project_id(v_task_id);
    if v_project_id is null then raise exception 'task not found' using errcode = '42501'; end if;
    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(v_task_id);
    v_role := private.lock_task_role(v_task_id, v_project_id, v_user);
    select * into v_item from public.task_items where id = p_task_item_id for update;
    if not found or v_item.task_id <> v_task_id or v_role is null
       or v_role not in ('owner', 'admin', 'member') then
        raise exception 'no access to task item' using errcode = '42501';
    end if;
    if v_item.is_archived or v_task.status = 'archived' or v_project.status <> 'active' then
        raise exception 'task item is archived' using errcode = '42501';
    end if;
    if v_item.sync_version <> p_expected_version then
        delete from private.client_operation_receipts
         where user_id = v_user and operation_id = p_operation_id;
        return pg_catalog.jsonb_build_object('status', 'conflict', 'version', v_item.sync_version,
            'item', pg_catalog.to_jsonb(v_item));
    end if;

    if p_kind = 'set_task_item_state' then
        perform public.set_task_item_state(p_task_item_id, (p_payload ->> 'completed')::boolean);
    elsif p_kind = 'set_task_item_percentage' then
        perform public.set_task_item_percentage(p_task_item_id, (p_payload ->> 'percentage')::integer);
    else
        perform public.set_task_item_comment(p_task_item_id, p_payload ->> 'comment');
    end if;
    select * into v_item from public.task_items where id = p_task_item_id;
    -- An accepted semantic no-op still advances the protocol version so the
    -- next queued operation always has a fresh, unambiguous precondition.
    if v_item.sync_version = p_expected_version then
        perform pg_catalog.set_config('tasktrace.force_sync_version_bump', 'on', true);
        update public.task_items set sync_version = sync_version where id = p_task_item_id;
        perform pg_catalog.set_config('tasktrace.force_sync_version_bump', 'off', true);
        select * into v_item from public.task_items where id = p_task_item_id;
    end if;
    v_result := pg_catalog.jsonb_build_object('status', 'applied', 'version', v_item.sync_version,
        'item', pg_catalog.to_jsonb(v_item));
    update private.client_operation_receipts
       set result_payload = v_result, completed_at = now()
     where user_id = v_user and operation_id = p_operation_id;
    return v_result;
end;
$$;
revoke all on function private.apply_task_item_operation_v2(uuid, uuid, bigint, text, jsonb) from public, anon, authenticated;

create function public.apply_task_item_state_operation_v2(
    p_operation_id uuid, p_task_item_id uuid, p_expected_version bigint, p_completed boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
    if p_completed is null then raise exception 'completed state required' using errcode = '22023'; end if;
    return private.apply_task_item_operation_v2(p_operation_id, p_task_item_id, p_expected_version,
        'set_task_item_state', pg_catalog.jsonb_build_object('completed', p_completed));
end;
$$;

create function public.apply_task_item_percentage_operation_v2(
    p_operation_id uuid, p_task_item_id uuid, p_expected_version bigint, p_percentage integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
    if p_percentage is null or p_percentage not between 0 and 100 then
        raise exception 'invalid percentage' using errcode = '22023'; end if;
    return private.apply_task_item_operation_v2(p_operation_id, p_task_item_id, p_expected_version,
        'set_task_item_percentage', pg_catalog.jsonb_build_object('percentage', p_percentage));
end;
$$;

create function public.apply_task_item_comment_operation_v2(
    p_operation_id uuid, p_task_item_id uuid, p_expected_version bigint, p_comment text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_comment text := nullif(pg_catalog.btrim(coalesce(p_comment, '')), '');
begin
    if v_comment is not null and pg_catalog.char_length(v_comment) > 10000 then
        raise exception 'invalid comment' using errcode = '22023'; end if;
    return private.apply_task_item_operation_v2(p_operation_id, p_task_item_id, p_expected_version,
        'set_task_item_comment', pg_catalog.jsonb_build_object('comment', v_comment));
end;
$$;

revoke execute on function public.get_task_item_sync_cursor() from public, anon;
revoke execute on function public.pull_task_item_changes(bigint, integer) from public, anon;
revoke execute on function public.apply_task_item_state_operation_v2(uuid, uuid, bigint, boolean) from public, anon;
revoke execute on function public.apply_task_item_percentage_operation_v2(uuid, uuid, bigint, integer) from public, anon;
revoke execute on function public.apply_task_item_comment_operation_v2(uuid, uuid, bigint, text) from public, anon;
grant execute on function public.get_task_item_sync_cursor() to authenticated;
grant execute on function public.pull_task_item_changes(bigint, integer) to authenticated;
grant execute on function public.apply_task_item_state_operation_v2(uuid, uuid, bigint, boolean) to authenticated;
grant execute on function public.apply_task_item_percentage_operation_v2(uuid, uuid, bigint, integer) to authenticated;
grant execute on function public.apply_task_item_comment_operation_v2(uuid, uuid, bigint, text) to authenticated;
