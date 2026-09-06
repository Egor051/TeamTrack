-- Replace per-task procedural membership checks with set-based audit inserts.
-- The audit trigger still emits one notification per affected recipient/event;
-- only the database round trips inside this RPC are reduced.
create or replace function public.remove_project_member(p_project_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = private, public as $$
declare
    v_user uuid := private.require_auth();
    v_role public.project_role;
begin
    perform private.lock_project(p_project_id);
    if not private.is_project_admin(p_project_id) then raise exception 'only owner/admin can manage project members' using errcode='insufficient_privilege'; end if;
    if not private.project_is_active(p_project_id) then raise exception 'project is archived'; end if;
    select role into v_role from public.project_members where project_id=p_project_id and user_id=p_user_id;
    if not found then return; end if;
    if v_role='owner' then raise exception 'cannot remove the project owner - transfer ownership first'; end if;

    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,new_data)
    select p_project_id, v_user, 'assignee_removed', 'task_assignee', p_user_id,
           jsonb_build_object('task_id', t.id, 'user_id', p_user_id, 'reason', 'project access removed')
      from public.tasks t
      join public.task_assignees a on a.task_id=t.id and a.user_id=p_user_id
     where t.project_id=p_project_id;

    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,new_data)
    select p_project_id, v_user, 'access_revoked', 'task_member', p_user_id,
           jsonb_build_object('task_id', t.id, 'user_id', p_user_id, 'reason', 'project access removed')
      from public.tasks t
      join public.task_members m on m.task_id=t.id and m.user_id=p_user_id
     where t.project_id=p_project_id;

    delete from public.task_assignees a using public.tasks t where a.task_id=t.id and t.project_id=p_project_id and a.user_id=p_user_id;
    delete from public.task_members m using public.tasks t where m.task_id=t.id and t.project_id=p_project_id and m.user_id=p_user_id;
    delete from public.project_members where project_id=p_project_id and user_id=p_user_id;
    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data)
    values(p_project_id,v_user,'member_removed','project_member',p_user_id,jsonb_build_object('user_id',p_user_id,'role',v_role));
end $$;
