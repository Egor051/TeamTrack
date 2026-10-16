-- Facets contain only this recipient's notifications. Invoker RLS also applies
-- to optional current project/stage names; historical names come from the event.
create function public.notification_filter_options()
returns jsonb language sql stable security invoker set search_path = '' as $$
  with notices as (
    select n.* from public.notifications n where n.user_id = (select auth.uid())
  ), projects as (
    select n.project_id as id,
      max(coalesce(p.name, n.data->>'project_name', 'Проект ' || left(n.project_id::text, 8))) as name
    from notices n left join public.projects p on p.id = n.project_id
    where n.project_id is not null group by n.project_id
  ), tasks as (
    select n.task_id as id, n.project_id,
      max(coalesce(t.title, n.data->>'task_title', 'Этап ' || left(n.task_id::text, 8))) as title
    from notices n left join public.tasks t on t.id = n.task_id
    where n.task_id is not null group by n.task_id, n.project_id
  )
  select jsonb_build_object(
    'projects', coalesce((select jsonb_agg(p order by p.name, p.id) from projects p), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(t order by t.title, t.id) from tasks t), '[]'::jsonb)
  );
$$;
revoke all on function public.notification_filter_options() from public, anon, service_role;
grant execute on function public.notification_filter_options() to authenticated;
