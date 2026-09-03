-- TaskTrace PostgreSQL schema v1 (historical baseline; do not deploy directly)
-- Canonical deployment source: supabase/migrations/*.sql
-- Target: Supabase PostgreSQL
--
-- Scope:
--   - profiles
--   - projects + project membership / roles
--   - tasks
--   - task access approvals
--   - task assignees
--   - checklist items
--   - immutable checkbox action history
--   - detailed audit log
--   - timestamps / basic integrity constraints
--
-- Intentionally NOT included yet:
--   - RLS policies
--   - Realtime publication configuration
--   - notifications
--   - comments
--   - subtasks
--   - offline sync
--   - advanced analytics
--
-- Notes:
--   1. Authentication users live in auth.users. profiles extends auth.users.
--   2. task_members represents approved access to a task.
--   3. task_assignees represents assignment, distinct from access.
--   4. item_actions is append-only history of checkbox state changes.
--   5. audit_log is the broader detailed system audit trail.
--   6. Checkbox mutations should later be exposed through an atomic RPC/function.

begin;

-- -----------------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------------

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

do $$
begin
    create type public.project_status as enum ('active', 'archived');
exception
    when duplicate_object then null;
end $$;

do $$
begin
    create type public.project_role as enum ('owner', 'admin', 'member', 'viewer');
exception
    when duplicate_object then null;
end $$;

do $$
begin
    create type public.task_status as enum ('not_started', 'in_progress', 'completed', 'archived');
exception
    when duplicate_object then null;
end $$;

do $$
begin
    create type public.item_action_type as enum ('checked', 'unchecked');
exception
    when duplicate_object then null;
end $$;

do $$
begin
    create type public.audit_action as enum (
        'created',
        'updated',
        'archived',
        'member_added',
        'member_removed',
        'role_changed',
        'access_approved',
        'access_revoked',
        'assignee_added',
        'assignee_removed',
        'checked',
        'unchecked',
        'reordered'
    );
exception
    when duplicate_object then null;
end $$;

-- -----------------------------------------------------------------------------
-- Generic updated_at trigger
-- -----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Profiles
-- -----------------------------------------------------------------------------

create table if not exists public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    display_name text not null,
    avatar_url text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint profiles_display_name_not_blank
        check (length(btrim(display_name)) > 0)
);

-- -----------------------------------------------------------------------------
-- Projects
-- -----------------------------------------------------------------------------

create table if not exists public.projects (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    description text,
    created_by uuid not null references auth.users(id),
    status public.project_status not null default 'active',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    archived_at timestamptz,

    constraint projects_name_not_blank
        check (length(btrim(name)) > 0),
    constraint projects_archive_consistency
        check (
            (status = 'archived' and archived_at is not null)
            or
            (status = 'active' and archived_at is null)
        )
);

-- -----------------------------------------------------------------------------
-- Project membership
-- -----------------------------------------------------------------------------

create table if not exists public.project_members (
    project_id uuid not null references public.projects(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    role public.project_role not null default 'member',
    joined_at timestamptz not null default now(),

    primary key (project_id, user_id)
);

-- -----------------------------------------------------------------------------
-- Tasks
-- -----------------------------------------------------------------------------

create table if not exists public.tasks (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.projects(id),
    title text not null,
    description text,
    status public.task_status not null default 'not_started',
    created_by uuid not null references auth.users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    archived_at timestamptz,

    constraint tasks_title_not_blank
        check (length(btrim(title)) > 0),
    constraint tasks_archive_consistency
        check (
            (status = 'archived' and archived_at is not null)
            or
            (status <> 'archived' and archived_at is null)
        )
);

-- -----------------------------------------------------------------------------
-- Approved access to tasks
--
-- Presence of a row means the user is approved for the task.
-- There is intentionally no pending-invitation state in v1.
-- -----------------------------------------------------------------------------

create table if not exists public.task_members (
    task_id uuid not null references public.tasks(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    approved_by uuid not null references auth.users(id),
    approved_at timestamptz not null default now(),
    created_at timestamptz not null default now(),

    primary key (task_id, user_id)
);

-- -----------------------------------------------------------------------------
-- Task assignees
--
-- An assignee must also be a task member. This cross-table rule should be
-- enforced by application/RPC logic and, where appropriate, database logic.
-- -----------------------------------------------------------------------------

create table if not exists public.task_assignees (
    task_id uuid not null references public.tasks(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    assigned_by uuid not null references auth.users(id),
    assigned_at timestamptz not null default now(),

    primary key (task_id, user_id)
);

-- -----------------------------------------------------------------------------
-- Checklist items
-- -----------------------------------------------------------------------------

create table if not exists public.task_items (
    id uuid primary key default gen_random_uuid(),
    task_id uuid not null references public.tasks(id) on delete cascade,
    title text not null,
    description text,
    position numeric(30,15) not null,
    is_completed boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    archived_at timestamptz,

    constraint task_items_title_not_blank
        check (length(btrim(title)) > 0),
    constraint task_items_archive_consistency
        check (
            (archived_at is null)
            or
            (archived_at is not null)
        )
);

-- Position uniqueness is scoped to a task. This prevents accidental duplicate
-- ordering values while still allowing decimal positions such as 1.5.
create unique index if not exists ux_task_items_task_position
    on public.task_items(task_id, position);

-- -----------------------------------------------------------------------------
-- Immutable checkbox action history
-- -----------------------------------------------------------------------------

create table if not exists public.item_actions (
    id bigint generated always as identity primary key,
    project_id uuid not null references public.projects(id),
    task_id uuid not null references public.tasks(id),
    task_item_id uuid not null references public.task_items(id),
    user_id uuid not null references auth.users(id),
    action public.item_action_type not null,
    created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Detailed audit log
-- -----------------------------------------------------------------------------

create table if not exists public.audit_log (
    id bigint generated always as identity primary key,
    project_id uuid not null references public.projects(id),
    user_id uuid references auth.users(id),
    action public.audit_action not null,
    entity_type text not null,
    entity_id uuid,
    old_data jsonb,
    new_data jsonb,
    created_at timestamptz not null default now(),

    constraint audit_log_entity_type_not_blank
        check (length(btrim(entity_type)) > 0)
);

-- -----------------------------------------------------------------------------
-- Indexes for joins, RLS predicates, history and common UI queries
-- -----------------------------------------------------------------------------

create index if not exists idx_projects_created_by
    on public.projects(created_by);

create index if not exists idx_project_members_user
    on public.project_members(user_id);

create index if not exists idx_project_members_project_role
    on public.project_members(project_id, role);

create index if not exists idx_tasks_project
    on public.tasks(project_id);

create index if not exists idx_tasks_created_by
    on public.tasks(created_by);

create index if not exists idx_task_members_user
    on public.task_members(user_id);

create index if not exists idx_task_assignees_user
    on public.task_assignees(user_id);

create index if not exists idx_task_items_task_position
    on public.task_items(task_id, position);

create index if not exists idx_item_actions_task_item_created
    on public.item_actions(task_item_id, created_at desc);

create index if not exists idx_item_actions_task_created
    on public.item_actions(task_id, created_at desc);

create index if not exists idx_item_actions_project_created
    on public.item_actions(project_id, created_at desc);

create index if not exists idx_item_actions_user_created
    on public.item_actions(user_id, created_at desc);

create index if not exists idx_audit_log_project_created
    on public.audit_log(project_id, created_at desc);

create index if not exists idx_audit_log_user_created
    on public.audit_log(user_id, created_at desc);

create index if not exists idx_audit_log_entity
    on public.audit_log(entity_type, entity_id, created_at desc);

-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------

 drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

 drop trigger if exists trg_projects_updated_at on public.projects;
create trigger trg_projects_updated_at
before update on public.projects
for each row
execute function public.set_updated_at();

 drop trigger if exists trg_tasks_updated_at on public.tasks;
create trigger trg_tasks_updated_at
before update on public.tasks
for each row
execute function public.set_updated_at();

 drop trigger if exists trg_task_items_updated_at on public.task_items;
create trigger trg_task_items_updated_at
before update on public.task_items
for each row
execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Structural constraints that can safely be enforced without RLS.
-- -----------------------------------------------------------------------------

-- A user can only be an assignee if they are a member of the same task.
-- This is NOT expressible as a plain CHECK constraint. It will be enforced by
-- controlled RPC/database functions when assignment operations are implemented.

-- An owner row should correspond to the project creator. Initial project
-- creation logic will create both the project and owner membership atomically.

-- -----------------------------------------------------------------------------
-- Important application/database contract
-- -----------------------------------------------------------------------------

-- 1. task_items.is_completed is the current state.
-- 2. item_actions is append-only historical truth for every checkbox change.
-- 3. Every checkbox state mutation must atomically:
--      a) authorize the caller,
--      b) update task_items,
--      c) insert item_actions,
--      d) insert matching audit_log row.
-- 4. Clients must not be given an unrestricted path to independently update
--    task_items and insert item_actions.
-- 5. RLS policies are intentionally added in a separate migration after the
--    schema exists, because access policy design depends on these relationships.

commit;
