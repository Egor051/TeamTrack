create or replace function public.restore_project(p_project_id uuid)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
  v_project public.projects%rowtype;
begin
  perform private.require_auth();
  perform private.lock_project(p_project_id);
  if not private.is_project_admin(p_project_id) then
    raise exception 'project admin role required' using errcode = '42501';
  end if;
  select * into v_project from public.projects where id = p_project_id;
  if not found then raise exception 'project not found'; end if;
  if v_project.status <> 'archived' then raise exception 'project is not archived'; end if;
  update public.projects set status = 'active', archived_at = null where id = p_project_id;
end;
$$;

create or replace function public.update_project(p_project_id uuid, p_name text, p_description text)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
begin
  perform private.require_auth();
  perform private.lock_project(p_project_id);
  if not private.is_project_admin(p_project_id) then
    raise exception 'project admin role required' using errcode = '42501';
  end if;
  if nullif(btrim(p_name), '') is null then raise exception 'project name cannot be empty'; end if;
  if not exists (select 1 from public.projects where id = p_project_id and status = 'active') then
    raise exception 'project must be active';
  end if;
  update public.projects
  set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), '')
  where id = p_project_id;
end;
$$;

revoke all on function public.restore_project(uuid) from public, anon;
revoke all on function public.update_project(uuid, text, text) from public, anon;
grant execute on function public.restore_project(uuid) to authenticated, service_role;
grant execute on function public.update_project(uuid, text, text) to authenticated, service_role;
