-- A stage has no independent membership role. Its effective role is always
-- inherited from the user's membership in the parent project.
create or replace function private.task_role_of(
    p_task_id uuid,
    p_user_id uuid default auth.uid()
)
returns public.project_role
language sql
stable
security definer
set search_path = private, public
as $$
    select pm.role
      from public.tasks t
      join public.project_members pm
        on pm.project_id = t.project_id
       and pm.user_id = p_user_id
     where t.id = p_task_id;
$$;

comment on function private.task_role_of(uuid, uuid) is
    'Returns the effective stage role inherited from project_members, or NULL for outsiders.';

-- Keep the access predicate and the role predicate on the same source of
-- truth. No task_members row is consulted here.
create or replace function private.has_task_access(
    p_task_id uuid,
    p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = private, public
as $$
    select private.task_role_of(p_task_id, p_user_id) is not null;
$$;

comment on function private.has_task_access(uuid, uuid) is
    'Effective stage access is granted by project_members through task_role_of. task_members is not required.';

create or replace function private.can_edit_task(
    p_task_id uuid,
    p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = private, public
as $$
    select private.task_role_of(p_task_id, p_user_id) is not null
       and private.task_role_of(p_task_id, p_user_id) <> 'viewer';
$$;

comment on function private.can_edit_task(uuid, uuid) is
    'Task edits require an inherited non-viewer project role.';

-- New private helpers must keep the same ACL boundary as the existing
-- authorization helpers.
revoke all on function private.task_role_of(uuid, uuid) from public, anon;
grant execute on function private.task_role_of(uuid, uuid) to authenticated, service_role;
