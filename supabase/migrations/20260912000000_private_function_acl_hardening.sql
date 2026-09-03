-- Internal authorization functions must never be a callable API surface.
-- PostgreSQL grants EXECUTE to PUBLIC by default; revoking only from
-- authenticated is insufficient because authenticated inherits PUBLIC.
revoke all on all functions in schema private from public, anon, authenticated;
revoke usage on schema private from public, anon;
grant usage on schema private to authenticated;

-- These predicates are evaluated by authenticated RLS policies. All other
-- private functions are trigger plumbing or RPC internals and remain
-- callable only by their definer (postgres).
grant execute on function
    private.is_project_member(uuid, uuid),
    private.is_project_admin(uuid, uuid),
    private.project_is_active(uuid),
    private.has_task_access(uuid, uuid),
    private.has_project_view_of_task(uuid, uuid),
    private.can_edit_task(uuid, uuid),
    private.audit_log_visible(uuid, text, uuid, jsonb, jsonb),
    private.can_view_profile(uuid)
    to authenticated;

-- Future private helpers must be explicitly granted as well.
alter default privileges for role postgres in schema private
    revoke all on functions from public, anon, authenticated;
