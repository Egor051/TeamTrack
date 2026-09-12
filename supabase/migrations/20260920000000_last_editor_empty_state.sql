-- Do not invent an editor when no profile row is available.  The function
-- still returns a row for a real audit actor; the client can fall back to the
-- stable user id fragment in that case, while a missing audit row returns no
-- row at all.
create or replace function public.list_task_item_last_editors(p_task_id uuid)
returns table(
    task_item_id uuid,
    user_id uuid,
    display_name text,
    changed_at timestamptz
)
language sql
stable
security definer
set search_path = private, public
as $$
    with task_context as (
        select t.id, t.project_id
          from public.tasks t
         where t.id = p_task_id
           and private.has_task_access(p_task_id)
    ), item_ids as (
        select ti.id
          from public.task_items ti
          join task_context tc on tc.id = ti.task_id
    ), ranked as (
        select a.entity_id as task_item_id,
               a.user_id,
               a.created_at as changed_at,
               row_number() over (
                   partition by a.entity_id
                   order by a.created_at desc, a.id desc
               ) as row_number
          from public.audit_log a
          join item_ids i on i.id = a.entity_id
          join task_context tc on tc.project_id = a.project_id
         where a.entity_type = 'task_item'
           and a.action <> 'created'
           and not (
               a.action = 'updated'
               and coalesce(a.old_data, '{}'::jsonb) ? 'title'
               and coalesce(a.new_data, '{}'::jsonb) ? 'title'
               and (coalesce(a.old_data, '{}'::jsonb) - 'title') =
                   (coalesce(a.new_data, '{}'::jsonb) - 'title')
           )
    )
    select r.task_item_id,
           r.user_id,
           nullif(p.display_name, '') as display_name,
           r.changed_at
      from ranked r
      left join public.profiles p on p.id = r.user_id
     where r.row_number = 1
$$;

revoke all on function public.list_task_item_last_editors(uuid) from public, anon;
grant execute on function public.list_task_item_last_editors(uuid) to authenticated, service_role;
