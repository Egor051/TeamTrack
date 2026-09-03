-- Internal authorization helpers must not be a public RPC surface.
-- RLS policies need EXECUTE on the small set of predicates they invoke;
-- trigger plumbing and mutation helpers are callable only by their definer.

do $$
begin
    execute 'revoke all on all functions in schema private from authenticated';

    execute 'grant execute on function
        private.is_project_member(uuid, uuid),
        private.is_project_admin(uuid, uuid),
        private.project_is_active(uuid),
        private.has_task_access(uuid, uuid),
        private.has_project_view_of_task(uuid, uuid),
        private.can_edit_task(uuid, uuid),
        private.audit_log_visible(uuid, text, uuid, jsonb, jsonb),
        private.can_view_profile(uuid)
        to authenticated';
end
$$;

-- Trigger functions do not need a caller-controlled search_path.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
    new.updated_at = now();
    return new;
end
$$;

create or replace function public.prevent_history_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
    raise exception
        'immutable history: % on public.% is not allowed (append-only table)',
        tg_op, tg_table_name
        using errcode = 'check_violation';
end
$$;

-- Cover the denormalized composite foreign keys used by history integrity.
create index if not exists idx_item_actions_task_project
    on public.item_actions(task_id, project_id);
create index if not exists idx_item_actions_item_task
    on public.item_actions(task_item_id, task_id);
create index if not exists idx_task_members_approved_by
    on public.task_members(approved_by);
create index if not exists idx_task_assignees_assigned_by
    on public.task_assignees(assigned_by);

-- Evaluate auth.uid() once per statement rather than once per profile row.
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
on public.profiles for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

drop policy if exists profiles_select_related on public.profiles;
create policy profiles_select_related
on public.profiles for select
to authenticated
using (id = (select auth.uid()) or private.can_view_profile(id));
