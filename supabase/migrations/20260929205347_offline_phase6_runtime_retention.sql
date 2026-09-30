-- Phase 6: remotely controlled capabilities and a bounded, reset-aware feed.
create table private.offline_runtime_config (
    singleton boolean primary key default true check (singleton),
    write_enabled boolean not null default false,
    sync_enabled boolean not null default false,
    updated_at timestamptz not null default now()
);
insert into private.offline_runtime_config(singleton) values (true);
alter table private.offline_runtime_config enable row level security;
revoke all on private.offline_runtime_config from public, anon, authenticated;

create function public.get_offline_runtime_config()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
    perform private.require_auth();
    return (select pg_catalog.jsonb_build_object(
        'write_enabled', write_enabled, 'sync_enabled', sync_enabled,
        'updated_at', updated_at, 'protocol_version', 2)
      from private.offline_runtime_config where singleton);
end;
$$;
revoke execute on function public.get_offline_runtime_config() from public, anon;
grant execute on function public.get_offline_runtime_config() to authenticated;

create table private.task_item_sync_retention (
    singleton boolean primary key default true check (singleton),
    retained_after_cursor bigint not null default 0 check (retained_after_cursor >= 0),
    updated_at timestamptz not null default now()
);
insert into private.task_item_sync_retention(singleton) values (true);
alter table private.task_item_sync_retention enable row level security;
revoke all on private.task_item_sync_retention from public, anon, authenticated;

create function private.cleanup_task_item_sync_changes()
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_floor bigint;
begin
    -- Same lock as the Phase 5 item statement trigger: no feed insert can race
    -- with advancing the floor in this transaction.
    perform pg_catalog.pg_advisory_xact_lock(29175, 5);
    with removed as (
        delete from private.task_item_sync_changes
         where created_at < pg_catalog.now() - interval '90 days'
         returning cursor
    ) select max(cursor) into v_floor from removed;
    if v_floor is not null then
        update private.task_item_sync_retention
           set retained_after_cursor = greatest(retained_after_cursor, v_floor),
               updated_at = pg_catalog.now()
         where singleton;
    end if;
    return (select retained_after_cursor from private.task_item_sync_retention where singleton);
end;
$$;
revoke all on function private.cleanup_task_item_sync_changes() from public, anon, authenticated;

create or replace function public.get_task_item_sync_cursor()
returns bigint language plpgsql security definer set search_path = '' as $$
begin
    perform private.require_auth();
    perform pg_catalog.pg_advisory_xact_lock(29175, 5);
    return greatest(
      coalesce((select max(cursor) from private.task_item_sync_changes), 0),
      (select retained_after_cursor from private.task_item_sync_retention where singleton));
end;
$$;

-- Preserve the Phase 5 RPC signature. Old clients fail explicitly when their
-- cursor has expired, rather than silently skipping pruned changes.
create or replace function public.pull_task_item_changes(p_after_cursor bigint, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_user uuid := private.require_auth();
    v_rows jsonb;
    v_cursor bigint;
    v_count integer;
    v_floor bigint;
begin
    if p_after_cursor is null or p_after_cursor < 0 or p_limit is null or p_limit < 1 or p_limit > 500 then
        raise exception 'invalid sync cursor or page size' using errcode = '22023';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(29175, 5);
    select retained_after_cursor into v_floor from private.task_item_sync_retention where singleton;
    if p_after_cursor < v_floor then
        raise exception 'task item sync cursor expired; reset required' using errcode = 'P0001';
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

create function public.pull_task_item_changes_v2(p_after_cursor bigint, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_floor bigint;
begin
    perform private.require_auth();
    if p_after_cursor is null or p_after_cursor < 0 or p_limit is null or p_limit < 1 or p_limit > 500 then
        raise exception 'invalid sync cursor or page size' using errcode = '22023';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(29175, 5);
    select retained_after_cursor into v_floor from private.task_item_sync_retention where singleton;
    if p_after_cursor < v_floor then
        return pg_catalog.jsonb_build_object('reset_required', true, 'retained_after_cursor', v_floor);
    end if;
    return public.pull_task_item_changes(p_after_cursor, p_limit);
end;
$$;
revoke execute on function public.pull_task_item_changes_v2(bigint, integer) from public, anon;
grant execute on function public.pull_task_item_changes_v2(bigint, integer) to authenticated;
