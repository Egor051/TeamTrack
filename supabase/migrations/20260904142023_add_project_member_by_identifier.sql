-- Resolve a member identifier only inside an authorized server-side operation.
create or replace function public.add_project_member_by_identifier(
    p_project_id uuid,
    p_identifier text,
    p_role public.project_role
)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_actor uuid := private.require_auth();
    v_identifier text := btrim(coalesce(p_identifier, ''));
    v_target uuid;
    v_count integer;
begin
    perform private.lock_project(p_project_id);
    if not private.is_project_admin(p_project_id, v_actor) then
        raise exception 'only owner/admin can manage project members' using errcode = 'insufficient_privilege';
    end if;
    if not private.project_is_active(p_project_id) then
        raise exception 'project is archived';
    end if;
    if p_role = 'owner' then
        raise exception 'use transfer_project_ownership to set a new owner';
    end if;
    if v_identifier = '' then
        raise exception 'identifier is required';
    end if;

    -- Email is checked first. auth.users is never exposed to the client.
    select count(*) into v_count
    from auth.users
    where email = v_identifier;
    if v_count = 1 then
        select id into v_target from auth.users where email = v_identifier limit 1;
    end if;
    if v_count = 0 then
        select count(*) into v_count
        from public.profiles
        where display_name = v_identifier;
        if v_count = 1 then
            select id into v_target from public.profiles where display_name = v_identifier limit 1;
        end if;
        if v_count > 1 then
            raise exception 'display name is ambiguous';
        end if;
    elsif v_count > 1 then
        raise exception 'email is ambiguous';
    end if;
    if v_count = 0 or v_target is null then
        raise exception 'user not found';
    end if;
    if exists (select 1 from public.project_members where project_id = p_project_id and user_id = v_target) then
        raise exception 'user is already a project member';
    end if;

    insert into public.project_members(project_id, user_id, role)
    values (p_project_id, v_target, p_role);
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, new_data)
    values (p_project_id, v_actor, 'member_added', 'project_member', v_target,
            jsonb_build_object('user_id', v_target, 'role', p_role));
end
$$;

revoke all on function public.add_project_member_by_identifier(uuid, text, public.project_role) from public, anon;
grant execute on function public.add_project_member_by_identifier(uuid, text, public.project_role) to authenticated;
