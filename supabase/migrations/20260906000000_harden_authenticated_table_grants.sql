-- Least-privilege hardening: RLS is the row boundary, table ACLs are the
-- operation boundary. The earlier authorization migration granted the narrow
-- privileges required by the app but did not revoke privileges inherited from
-- the local/hosted role bootstrap.
do $$
begin
  execute 'revoke all on public.profiles, public.projects, public.project_members,
                    public.tasks, public.task_members, public.task_assignees,
                    public.task_items, public.item_actions, public.audit_log,
                    public.notifications from anon, authenticated';
  execute 'grant select on public.profiles, public.projects, public.project_members,
                    public.tasks, public.task_members, public.task_assignees,
                    public.task_items, public.item_actions, public.audit_log,
                    public.notifications to authenticated';
  execute 'grant insert, update on public.profiles to authenticated';
  execute 'grant update on public.projects, public.tasks to authenticated';
end
$$;
