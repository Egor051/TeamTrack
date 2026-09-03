-- TaskTrace — initial database schema (migration 0001)
-- Target: Supabase PostgreSQL (Postgres 15+)
--
-- Derived from the architectural baseline `tasktrace_schema.sql` v1 with the
-- following corrections (rationale in commit message / task report):
--   1. task_items: added is_archived + a meaningful archive-consistency CHECK
--      (the baseline constraint was a tautology).
--   2. item_actions: composite FKs make the denormalized project_id/task_id
--      provably consistent with task_items/tasks (RLS will trust them).
--   3. item_actions / audit_log: append-only guard triggers (immutable history).
--   4. Explicit FK delete behavior: structural children CASCADE, history and
--      attribution columns RESTRICT (hard deletes cannot destroy history).
--   5. Partial unique index: at most one 'owner' project member per project.
--   6. RLS is ENABLED on every public table with zero policies => deny-by-default
--      for anon/authenticated. Policies are added in a dedicated later migration.
--
-- Deferred by design (do not add here):
--   - RLS policies (separate migration)
--   - atomic checkbox RPC (implemented in the authorization migration)
--   - assignee-must-be-task-member enforcement RPC (implemented later)
--   - project creation RPC (implemented later, atomically)
--   - realtime publication, notifications, comments, subtasks, sync, analytics
--
-- Identity model:
--   Supabase Auth users live in auth.users (managed by Supabase).
--   public.profiles extends auth.users with app-specific profile data.
--   There is intentionally NO public.users table duplicating auth data.

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------

create type public.project_status as enum ('active', 'archived');

create type public.project_role as enum ('owner', 'admin', 'member', 'viewer');

create type public.task_status as enum ('not_started', 'in_progress', 'completed', 'archived');

create type public.item_action_type as enum ('checked', 'unchecked');

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

-- -----------------------------------------------------------------------------
-- Generic updated_at trigger function
-- -----------------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Append-only guard for history tables
--
-- item_actions and audit_log are immutable. Normal operations must only INSERT.
-- UPDATE / DELETE / TRUNCATE are rejected at the database level so that
-- archiving a project/task/item can never destroy history.
-- -----------------------------------------------------------------------------

create function public.prevent_history_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
    raise exception
        'immutable history: % on public.% is not allowed (append-only table)',
        tg_op, tg_table_name
        using errcode = 'check_violation';
end;
$$;



-- -----------------------------------------------------------------------------
-- Profiles
-- -----------------------------------------------------------------------------

create table public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    display_name text not null,
    avatar_url text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint profiles_display_name_not_blank
        check (length(btrim(display_name)) > 0)
);

comment on table public.profiles is
    'App-specific profile data for Supabase Auth users (auth.users is the identity source). One row per auth user.';

-- -----------------------------------------------------------------------------
-- Projects
-- -----------------------------------------------------------------------------

create table public.projects (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    description text,
    created_by uuid not null references auth.users(id) on delete restrict,
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

comment on table public.projects is
    'Archiving (status=''archived'' + archived_at) is the only normal removal flow. Hard DELETE is blocked while history rows reference the project.';

-- -----------------------------------------------------------------------------
-- Project membership
-- -----------------------------------------------------------------------------

create table public.project_members (
    project_id uuid not null references public.projects(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    role public.project_role not null default 'member',
    joined_at timestamptz not null default now(),

    primary key (project_id, user_id)
);

-- A project has exactly one owner (the creator).
create unique index ux_project_members_single_owner
    on public.project_members(project_id)
    where role = 'owner';

-- -----------------------------------------------------------------------------
-- Tasks
-- -----------------------------------------------------------------------------

create table public.tasks (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references public.projects(id) on delete cascade,
    title text not null,
    description text,
    status public.task_status not null default 'not_started',
    created_by uuid not null references auth.users(id) on delete restrict,
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

-- Used by the composite FK from item_actions; also serves task lookups by id.
create unique index ux_tasks_id_project
    on public.tasks(id, project_id);

-- -----------------------------------------------------------------------------
-- Approved access to tasks (task_members)
--
-- task_members = APPROVED ACCESS to a concrete task. Presence of a row means
-- the user may see/work with that specific task. A project member (even admin)
-- does NOT automatically gain access to every task; access must be approved by
-- owner/admin. There is intentionally no pending-invitation state in v1.
-- -----------------------------------------------------------------------------

create table public.task_members (
    task_id uuid not null references public.tasks(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    approved_by uuid not null references auth.users(id) on delete restrict,
    approved_at timestamptz not null default now(),
    created_at timestamptz not null default now(),

    primary key (task_id, user_id)
);

comment on table public.task_members is
    'APPROVED per-task access. Distinct from task_assignees: membership grants access, assignment names responsibility. Owner/admin approve access; approval is recorded in approved_by/approved_at.';

-- -----------------------------------------------------------------------------
-- Task assignees (task_assignees)
--
-- task_assignees = WHO IS RESPONSIBLE for a task. Multiple assignees allowed.
-- An assignee must also be a task member (same task_id, user_id) — a cross-table
-- rule not expressible as a plain CHECK; enforced by controlled RPC when
-- Assignment operations are implemented in the authorization migration.
-- -----------------------------------------------------------------------------

create table public.task_assignees (
    task_id uuid not null references public.tasks(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    assigned_by uuid not null references auth.users(id) on delete restrict,
    assigned_at timestamptz not null default now(),

    primary key (task_id, user_id)
);

comment on table public.task_assignees is
    'Multiple assignees per task. Semantically separate from task_members: assignment != access. An assignee is always required to also be a task member (enforced by RPC, not CHECK).';

-- -----------------------------------------------------------------------------
-- Checklist items
--
-- position numeric(30,15): arbitrary reordering without renumbering — inserting
-- between positions 1 and 2 writes 1.5. Uniqueness is scoped per task.
-- -----------------------------------------------------------------------------

create table public.task_items (
    id uuid primary key default gen_random_uuid(),
    task_id uuid not null references public.tasks(id) on delete cascade,
    title text not null,
    description text,
    position numeric(30,15) not null,
    is_completed boolean not null default false,
    is_archived boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    archived_at timestamptz,

    constraint task_items_title_not_blank
        check (length(btrim(title)) > 0),
    constraint task_items_archive_consistency
        check (
            (not is_archived and archived_at is null)
            or
            (is_archived and archived_at is not null)
        )
);

create unique index ux_task_items_task_position
    on public.task_items(task_id, position);

-- Used by the composite FK from item_actions.
create unique index ux_task_items_id_task
    on public.task_items(id, task_id);

comment on table public.task_items is
    'Current checkbox state (is_completed) for ~40 items per task. Archive via is_archived+archived_at (soft delete only). Items are reordered via fractional position values (e.g. 1.5), no renumbering.';


-- -----------------------------------------------------------------------------
-- IMPORTANT: atomic checkbox mutation contract (implemented in a later RPC)
--
-- Clients must NEVER perform two independent operations:
--     UPDATE task_items SET is_completed = ...;
--     INSERT INTO item_actions ...;
-- Instead, one server-side RPC (security definer) must atomically:
--     1) authenticate/authorize the caller;
--     2) lock or safely update the target task_items row
--        (SELECT ... FOR UPDATE, reject conflicting/parallel state changes);
--     3) update task_items.is_completed;
--     4) insert the matching item_actions row (checked/unchecked);
--     5) insert the corresponding audit_log row;
--     6) commit atomically.
-- The RPC and the corresponding write revocations are implemented in the
-- authorization migration. Keep this contract here as a schema invariant.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- Immutable checkbox action history
--
-- Append-only: every check/uncheck operation ever performed, denormalized with
-- project_id/task_id for efficient RLS and history queries. Composite FKs make
-- the denormalized columns provably consistent with task_items/tasks.
-- project_id/task_id/task_item_id/user_id FKs are RESTRICT: hard-deleting a
-- project/task/item/user is impossible while their history exists — history
-- survives archiving by construction.
-- -----------------------------------------------------------------------------

create table public.item_actions (
    id bigint generated always as identity primary key,
    project_id uuid not null references public.projects(id) on delete restrict,
    task_id uuid not null references public.tasks(id) on delete restrict,
    task_item_id uuid not null references public.task_items(id) on delete restrict,
    user_id uuid not null references auth.users(id) on delete restrict,
    action public.item_action_type not null,
    created_at timestamptz not null default now(),

    foreign key (task_id, project_id) references public.tasks(id, project_id),
    foreign key (task_item_id, task_id) references public.task_items(id, task_id)
);

comment on table public.item_actions is
    'APPEND-ONLY history of every checkbox check/uncheck (one row per operation, with the acting user). Current state lives in task_items.is_completed. UPDATE/DELETE/TRUNCATE are blocked by trg_item_actions_no_*. Distinct from audit_log: item_actions is the focused per-item action log; audit_log is the broad system-level old_data/new_data trail.';

-- -----------------------------------------------------------------------------
-- Detailed audit log
--
-- Separate, broader system audit trail. old_data/new_data are JSONB snapshots
-- of changed fields, e.g. old_data = {"title": "Old title"},
-- new_data = {"title": "New title"}. Do not reduce this to a text description.
-- entity_type/entity_id is polymorphic (values documented below); therefore no
-- FK on entity_id — only project_id is enforced.
-- -----------------------------------------------------------------------------

create table public.audit_log (
    id bigint generated always as identity primary key,
    project_id uuid not null references public.projects(id) on delete restrict,
    user_id uuid references auth.users(id) on delete restrict,
    action public.audit_action not null,
    entity_type text not null,
    entity_id uuid,
    old_data jsonb,
    new_data jsonb,
    created_at timestamptz not null default now(),

    constraint audit_log_entity_type_not_blank
        check (length(btrim(entity_type)) > 0)
);

comment on table public.audit_log is
    'APPEND-ONLY detailed system audit trail with JSONB old_data/new_data field snapshots. UPDATE/DELETE/TRUNCATE are blocked by trg_audit_log_no_*. Expected entity_type values: ''profile'' | ''project'' | ''task'' | ''task_item'' | ''project_member'' | ''task_member'' | ''task_assignee''. user_id may be null only for system-originated actions.';

comment on column public.audit_log.old_data is
    'JSONB snapshot of changed fields before the action, e.g. {"title": "Old title"}. Null for created actions.';
comment on column public.audit_log.new_data is
    'JSONB snapshot of changed fields after the action, e.g. {"title": "New title"}. Null for archived/removed actions.';


-- -----------------------------------------------------------------------------
-- Indexes for joins, RLS predicates, history and common UI queries
-- -----------------------------------------------------------------------------

create index idx_projects_created_by
    on public.projects(created_by);

create index idx_project_members_user
    on public.project_members(user_id);

create index idx_project_members_project_role
    on public.project_members(project_id, role);

create index idx_tasks_project
    on public.tasks(project_id);

create index idx_tasks_created_by
    on public.tasks(created_by);

create index idx_task_members_user
    on public.task_members(user_id);

create index idx_task_assignees_user
    on public.task_assignees(user_id);

-- ux_task_items_task_position(task_id, position) already serves task_id lookups
-- and ordered listing, so no separate task_items(task_id) index is needed.

create index idx_item_actions_task_item_created
    on public.item_actions(task_item_id, created_at desc);

create index idx_item_actions_task_created
    on public.item_actions(task_id, created_at desc);

create index idx_item_actions_project_created
    on public.item_actions(project_id, created_at desc);

create index idx_item_actions_user_created
    on public.item_actions(user_id, created_at desc);

create index idx_audit_log_project_created
    on public.audit_log(project_id, created_at desc);

create index idx_audit_log_user_created
    on public.audit_log(user_id, created_at desc);

create index idx_audit_log_entity
    on public.audit_log(entity_type, entity_id, created_at desc);

-- -----------------------------------------------------------------------------
-- updated_at triggers
-- -----------------------------------------------------------------------------

create trigger trg_profiles_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

create trigger trg_projects_updated_at
before update on public.projects
for each row
execute function public.set_updated_at();

create trigger trg_tasks_updated_at
before update on public.tasks
for each row
execute function public.set_updated_at();

create trigger trg_task_items_updated_at
before update on public.task_items
for each row
execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Append-only enforcement triggers (immutable history)
-- -----------------------------------------------------------------------------

create trigger trg_item_actions_no_update
before update on public.item_actions
for each row
execute function public.prevent_history_mutation();

create trigger trg_item_actions_no_delete
before delete on public.item_actions
for each row
execute function public.prevent_history_mutation();

create trigger trg_item_actions_no_truncate
before truncate on public.item_actions
for each statement
execute function public.prevent_history_mutation();

create trigger trg_audit_log_no_update
before update on public.audit_log
for each row
execute function public.prevent_history_mutation();

create trigger trg_audit_log_no_delete
before delete on public.audit_log
for each row
execute function public.prevent_history_mutation();

create trigger trg_audit_log_no_truncate
before truncate on public.audit_log
for each statement
execute function public.prevent_history_mutation();

-- -----------------------------------------------------------------------------
-- Row Level Security: ENABLED, zero policies (deny-by-default)
--
-- Every table is inaccessible to anon/authenticated until the dedicated RLS
-- migration adds policies. service_role (server-side) bypasses RLS as usual.
-- This keeps the schema safe between this migration and the RLS stage.
-- -----------------------------------------------------------------------------

alter table public.profiles        enable row level security;
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;
alter table public.tasks           enable row level security;
alter table public.task_members    enable row level security;
alter table public.task_assignees  enable row level security;
alter table public.task_items      enable row level security;
alter table public.item_actions    enable row level security;
alter table public.audit_log       enable row level security;

-- -----------------------------------------------------------------------------
-- Deferred design notes (historical sequencing notes)
--
-- 1. RLS policies: separate migration. Key predicates will use
--    project_members(project_id, user_id, role), task_members(task_id, user_id)
--    and the denormalized project_id/task_id on history tables (kept consistent
--    by the composite FKs above).
-- 2. Atomic checkbox RPC: implemented in the authorization migration; it does
--    lock -> update task_items -> insert item_actions -> insert audit_log in
--    one transaction.
-- 3. Assignee-must-be-task-member: enforced inside the assignee-management RPC
--    (owner/admin only).
-- 4. Project creation RPC: implemented in the authorization migration and
--    creates the project + owner project_members row atomically.
-- 5. Profile provisioning on signup: implemented by the auth.users trigger in
--    the profile provisioning migration.
-- 6. If hard data purges ever become necessary (e.g. GDPR erasure), they must
--    be explicit maintenance operations that intentionally drop the append-only
--    guard triggers first — never part of normal application flows.
-- -----------------------------------------------------------------------------
