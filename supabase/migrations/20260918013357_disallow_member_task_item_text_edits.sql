-- Prevent project members with role = 'member' from changing task item text.
-- Members can still update progress/checklist state and comments through their
-- dedicated RPCs. Owner/admin text-edit permissions remain unchanged.

CREATE OR REPLACE FUNCTION public.update_task_item(
  p_task_item_id uuid,
  p_title text DEFAULT NULL::text,
  p_description text DEFAULT NULL::text,
  p_position numeric DEFAULT NULL::numeric
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'private', 'public'
AS $function$
declare
  v_user uuid:=private.require_auth();
  v_task_id uuid;
  v_project_id uuid;
  v_task public.tasks%rowtype;
  r public.task_items%rowtype;
  v_old jsonb:='{}'::jsonb;
  v_new jsonb:='{}'::jsonb;
  v_action public.audit_action;
begin
  select task_id into v_task_id from public.task_items where id=p_task_item_id;
  if not found then raise exception 'task item not found'; end if;

  v_project_id:=private.task_project_id(v_task_id);
  perform private.lock_project(v_project_id);
  v_task:=private.lock_task(v_task_id);

  select * into r
  from public.task_items
  where id=p_task_item_id
  for update;

  if not private.has_task_access(r.task_id)
     or private.project_role_of(v_task.project_id)='viewer'
  then
    raise exception 'no access to task item' using errcode='insufficient_privilege';
  end if;

  if v_task.status='archived'
     or not private.project_is_active(v_task.project_id)
     or r.is_archived
  then
    raise exception 'task item is archived';
  end if;

  if private.project_role_of(v_task.project_id)='member'
     and (
       (p_title is not null and p_title is distinct from r.title)
       or
       (p_description is not null and p_description is distinct from r.description)
     )
  then
    raise exception 'members cannot modify task item text'
      using errcode='insufficient_privilege';
  end if;

  if p_position is not null
     and (p_position<0 or p_position='NaN'::numeric)
  then
    raise exception 'item position must be a non-negative finite number';
  end if;

  if p_title is not null and p_title is distinct from r.title then
    if length(btrim(p_title))=0 then
      raise exception 'item title must not be blank';
    end if;
    v_old:=v_old||jsonb_build_object('title',r.title);
    v_new:=v_new||jsonb_build_object('title',p_title);
  end if;

  if p_description is not null and p_description is distinct from r.description then
    v_old:=v_old||jsonb_build_object('description',r.description);
    v_new:=v_new||jsonb_build_object('description',p_description);
  end if;

  if p_position is not null and p_position is distinct from r.position then
    v_old:=v_old||jsonb_build_object('position',r.position);
    v_new:=v_new||jsonb_build_object('position',p_position);
  end if;

  if v_new='{}'::jsonb then return; end if;

  update public.task_items
  set title=coalesce(p_title,title),
      description=coalesce(p_description,description),
      position=coalesce(p_position,position)
  where id=r.id;

  v_action:=case when v_old ? 'position' then 'reordered' else 'updated' end::public.audit_action;

  insert into public.audit_log(
    project_id,user_id,action,entity_type,entity_id,old_data,new_data
  )
  values(v_task.project_id,v_user,v_action,'task_item',r.id,v_old,v_new);
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_task_item(
  p_task_item_id uuid,
  p_title text DEFAULT NULL::text,
  p_description text DEFAULT NULL::text,
  p_position numeric DEFAULT NULL::numeric,
  p_comment text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'private', 'public'
AS $function$
declare
  v_user uuid := private.require_auth();
  v_task_id uuid;
  v_project_id uuid;
  v_task public.tasks%rowtype;
  r public.task_items%rowtype;
  v_old jsonb := '{}'::jsonb;
  v_new jsonb := '{}'::jsonb;
begin
  select task_id into v_task_id from public.task_items where id=p_task_item_id;
  if not found then raise exception 'task item not found'; end if;

  v_project_id:=private.task_project_id(v_task_id);
  perform private.lock_project(v_project_id);
  v_task:=private.lock_task(v_task_id);

  select * into r
  from public.task_items
  where id=p_task_item_id
  for update;

  if not private.has_task_access(r.task_id)
     or private.project_role_of(v_task.project_id)='viewer'
  then
    raise exception 'no access to task item' using errcode='insufficient_privilege';
  end if;

  if v_task.status='archived'
     or not private.project_is_active(v_task.project_id)
     or r.is_archived
  then
    raise exception 'task item is archived';
  end if;

  if private.project_role_of(v_task.project_id)='member'
     and (
       (p_title is not null and p_title is distinct from r.title)
       or
       (p_description is not null and p_description is distinct from r.description)
     )
  then
    raise exception 'members cannot modify task item text'
      using errcode='insufficient_privilege';
  end if;

  if p_position is not null
     and (p_position<0 or p_position='NaN'::numeric)
  then
    raise exception 'item position must be a non-negative finite number';
  end if;

  if p_title is not null and p_title is distinct from r.title then
    if char_length(btrim(p_title))=0 or char_length(p_title)>500 then
      raise exception 'item title must contain 1..500 characters';
    end if;
    v_old:=v_old||jsonb_build_object('title',r.title);
    v_new:=v_new||jsonb_build_object('title',p_title);
  end if;

  if p_description is not null and p_description is distinct from r.description then
    if char_length(p_description)>10000 then
      raise exception 'item description is too long';
    end if;
    v_old:=v_old||jsonb_build_object('description',r.description);
    v_new:=v_new||jsonb_build_object('description',p_description);
  end if;

  if p_position is not null and p_position is distinct from r.position then
    v_old:=v_old||jsonb_build_object('position',r.position);
    v_new:=v_new||jsonb_build_object('position',p_position);
  end if;

  if p_comment is not null and p_comment is distinct from r.comment then
    if char_length(p_comment)>2000 then
      raise exception 'item comment is too long';
    end if;
    v_old:=v_old||jsonb_build_object('comment',r.comment);
    v_new:=v_new||jsonb_build_object('comment',p_comment);
  end if;

  if v_new='{}'::jsonb then return; end if;

  update public.task_items
  set title=coalesce(p_title,title),
      description=coalesce(p_description,description),
      position=coalesce(p_position,position),
      comment=case when p_comment is null then comment else p_comment end
  where id=r.id;

  insert into public.audit_log(
    project_id,user_id,action,entity_type,entity_id,old_data,new_data
  )
  values(v_task.project_id,v_user,'updated','task_item',r.id,v_old,v_new);
end;
$function$;
