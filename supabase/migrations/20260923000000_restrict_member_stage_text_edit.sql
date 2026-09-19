-- Stage title and description are project-admin controlled metadata.
-- Members keep their existing checklist progress/comment permissions, but may
-- not mutate the stage row through either the RPC or the Data API.

drop policy if exists tasks_update_editable on public.tasks;

create policy tasks_update_editable
on public.tasks for update
to authenticated
using (
    private.is_project_admin(project_id)
    and status <> 'archived'
    and private.project_is_active(project_id)
)
with check (
    private.is_project_admin(project_id)
    and status <> 'archived'
);

create or replace function public.update_task(
    p_task_id uuid,
    p_title text default null,
    p_description text default null
)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    r public.tasks%rowtype;
    v_title text;
    v_description text;
begin
    select * into r
    from public.tasks
    where id = p_task_id
    for update;

    if not found or not private.is_project_admin(r.project_id) then
        raise exception 'only owner/admin can edit stage details'
            using errcode = 'insufficient_privilege';
    end if;
    if r.status = 'archived' or not private.project_is_active(r.project_id) then
        raise exception 'task is archived';
    end if;

    v_title := case when p_title is null then r.title else btrim(p_title) end;
    v_description := case
        when p_description is null then r.description
        else nullif(btrim(p_description), '')
    end;

    if char_length(v_title) < 1 or char_length(v_title) > 500 then
        raise exception 'task title must contain 1..500 characters';
    end if;
    if v_description is not null and char_length(v_description) > 10000 then
        raise exception 'task description is too long';
    end if;
    if v_title is not distinct from r.title
       and v_description is not distinct from r.description then
        return;
    end if;

    update public.tasks
    set title = v_title,
        description = v_description
    where id = r.id;

    insert into public.audit_log
        (project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values
        (r.project_id, v_user, 'updated', 'task', r.id,
         jsonb_build_object('title', r.title, 'description', r.description),
         jsonb_build_object('title', v_title, 'description', v_description));
end;
$$;

revoke all on function public.update_task(uuid, text, text) from public, anon;
grant execute on function public.update_task(uuid, text, text) to authenticated, service_role;
