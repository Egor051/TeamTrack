-- Existing rows remain inheritance/override metadata. Only an explicit grant
-- can create independent stage access; no historical orphan is promoted.
begin;
set local lock_timeout = '3s';
alter table public.task_members add column is_direct boolean not null default false;
comment on column public.task_members.is_direct is
  'Explicit stage membership. False preserves legacy project inheritance; never grants project membership.';
comment on table public.task_members is
  'Explicit stage membership plus optional checklist role override. Project roles still grant inherited access; historical rows are not independent grants.';

create or replace function private.task_role_of(p_task_id uuid, p_user_id uuid default auth.uid())
returns public.project_role language sql stable security definer set search_path = '' as $$
  select coalesce(tm.role_override, pm.role, case when tm.is_direct then 'viewer'::public.project_role end)
  from public.tasks t
  left join public.project_members pm on pm.project_id=t.project_id and pm.user_id=p_user_id
  left join public.task_members tm on tm.task_id=t.id and tm.user_id=p_user_id
  where t.id=p_task_id and (pm.user_id is not null or tm.is_direct);
$$;
create or replace function private.lock_task_role(p_task_id uuid, p_project_id uuid, p_user_id uuid)
returns public.project_role language plpgsql security definer set search_path = '' as $$
declare v_project_role public.project_role; v_member public.task_members%rowtype;
begin
  v_project_role := private.lock_project_role(p_project_id,p_user_id);
  select * into v_member from public.task_members where task_id=p_task_id and user_id=p_user_id for update;
  if v_project_role is null and not coalesce(v_member.is_direct,false) then return null; end if;
  return coalesce(v_member.role_override,v_project_role,case when v_member.is_direct then 'viewer'::public.project_role end);
end $$;
drop policy tasks_select_project_member on public.tasks;
create policy tasks_select_project_member on public.tasks for select to authenticated
  using (private.current_has_task_access(id));

-- The project table and its membership RLS stay project-scoped. A stage-only
-- user receives only the parent label/status required to display this stage.
create function public.get_task_project_context(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := private.require_auth(); v_result jsonb;
begin
  if not private.has_task_access(p_task_id,v_user) then
    raise exception 'no access to task' using errcode='42501';
  end if;
  select jsonb_build_object('id',p.id,'name',p.name,'status',p.status,'role',pm.role) into v_result
    from public.tasks t join public.projects p on p.id=t.project_id
    left join public.project_members pm on pm.project_id=p.id and pm.user_id=v_user where t.id=p_task_id;
  return v_result;
end $$;

create function public.list_task_participants(p_task_id uuid)
returns table(user_id uuid, display_name text, project_role public.project_role,
  direct_role public.project_role, effective_role public.project_role, is_direct boolean, set_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := private.require_auth(); v_project uuid;
begin
  if not private.has_task_access(p_task_id,v_user) then
    raise exception 'no access to task' using errcode='42501';
  end if;
  v_project := private.task_project_id(p_task_id);
  return query
    with subjects as (select pm.user_id from public.project_members pm where pm.project_id=v_project
      union select tm.user_id from public.task_members tm where tm.task_id=p_task_id and tm.is_direct)
    select s.user_id,p.display_name,pm.role,tm.role_override,coalesce(tm.role_override,pm.role,'viewer'::public.project_role),coalesce(tm.is_direct,false),tm.set_at
    from subjects s join public.profiles p on p.id=s.user_id
    left join public.project_members pm on pm.project_id=v_project and pm.user_id=s.user_id
    left join public.task_members tm on tm.task_id=p_task_id and tm.user_id=s.user_id
    order by p.display_name,s.user_id;
end $$;

-- Shared mutation guard keeps the established lock order and project authority.
create function private.lock_task_membership_management(p_task_id uuid, p_target uuid)
returns public.project_role language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := private.require_auth(); v_project public.projects%rowtype;
  v_task public.tasks%rowtype; v_role public.project_role; v_target public.project_role;
begin
  v_project := private.lock_project_state(private.task_project_id(p_task_id));
  v_task := private.lock_task(p_task_id);
  v_role := private.lock_project_role(v_project.id,v_actor);
  v_target := private.lock_project_role(v_project.id,p_target);
  if v_role is null or v_role not in ('owner','admin') then
    raise exception 'only owner/admin can manage stage access' using errcode='42501';
  end if;
  if p_target=v_actor then raise exception 'cannot change your own role' using errcode='42501'; end if;
  if v_role='admin' and v_target in ('owner','admin') then
    raise exception 'only the owner can manage owner/admin checklist overrides' using errcode='42501';
  end if;
  if v_project.status<>'active' or v_task.status='archived' then raise exception 'task is archived'; end if;
  return v_target;
end $$;

create or replace function public.set_task_member_override(p_task_id uuid,p_user_id uuid,p_role public.project_role)
returns void language plpgsql security definer set search_path = '' as $$
declare v_inherited public.project_role; v_old public.task_members%rowtype;
begin
  v_inherited := private.lock_task_membership_management(p_task_id,p_user_id);
  if p_role is null or p_role='owner' then raise exception 'invalid checklist role' using errcode='22023'; end if;
  select * into v_old from public.task_members where task_id=p_task_id and user_id=p_user_id for update;
  if v_inherited is null and not coalesce(v_old.is_direct,false) then raise exception 'target has no stage access'; end if;
  if v_old.role_override=p_role then return; end if;
  insert into public.task_members(task_id,user_id,set_by,role_override)
    values(p_task_id,p_user_id,auth.uid(),p_role)
    on conflict(task_id,user_id) do update set role_override=excluded.role_override,set_by=excluded.set_by,set_at=now();
  insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data,new_data)
    values(private.task_project_id(p_task_id),auth.uid(),'role_changed','task_member',p_user_id,
      jsonb_build_object('task_id',p_task_id,'role_override',v_old.role_override),
      jsonb_build_object('task_id',p_task_id,'role_override',p_role,'inherited_role',v_inherited));
end $$;

create or replace function public.clear_task_member_override(p_task_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_inherited public.project_role; v_old public.task_members%rowtype;
begin
  v_inherited := private.lock_task_membership_management(p_task_id,p_user_id);
  if v_inherited is null then raise exception 'stage-only member has no project role to inherit'; end if;
  select * into v_old from public.task_members where task_id=p_task_id and user_id=p_user_id for update;
  if v_old.role_override is null then return; end if;
  -- Inheritance and direct membership are separate. Clearing the override
  -- preserves the explicit membership and follows future project role changes.
  update public.task_members set role_override=null,set_by=auth.uid(),set_at=now()
    where task_id=p_task_id and user_id=p_user_id;
  insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data,new_data)
    values(private.task_project_id(p_task_id),auth.uid(),'role_changed','task_member',p_user_id,
      jsonb_build_object('task_id',p_task_id,'role_override',v_old.role_override),
      jsonb_build_object('task_id',p_task_id,'role_override',null,'inherited_role',v_inherited));
end $$;

create function public.add_task_member_by_identifier(p_task_id uuid,p_identifier text,p_role public.project_role)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := private.require_auth(); v_project uuid := private.task_project_id(p_task_id);
  v_identifier text := btrim(coalesce(p_identifier,'')); v_target uuid; v_count integer;
  v_window timestamptz; v_attempts integer; v_existing public.task_members%rowtype;
begin
  if p_role is null or p_role='owner' or char_length(v_identifier) not between 1 and 320 then
    raise exception 'invalid member identifier or role' using errcode='22023';
  end if;
  -- Authorize before looking up any account or consuming the shared quota.
  perform private.lock_task_membership_management(p_task_id,null);
  v_window := date_trunc('minute',clock_timestamp());
  insert into private.member_identifier_limits as quota(user_id,window_start,attempts) values(v_actor,v_window,1)
    on conflict(user_id) do update set window_start=excluded.window_start,
      attempts=case when quota.window_start=excluded.window_start then least(quota.attempts+1,21) else 1 end
    returning attempts into v_attempts;
  if v_attempts>20 then
    perform set_config('response.status','429',true);
    return jsonb_build_object('code','PT429','message','Слишком много попыток добавления участников. Повторите через минуту.','details',null,'hint',null);
  end if;
  select count(*),(array_agg(id order by id))[1] into v_count,v_target from auth.users where email=lower(v_identifier);
  if v_count=0 then select count(*),(array_agg(id order by id))[1] into v_count,v_target from public.profiles where display_name=v_identifier; end if;
  if v_count=1 and v_target is not null then
    -- Business denials return an envelope so failed lookups retain their quota.
    if v_target=v_actor or (private.project_role_of(v_project,v_actor)='admin'
       and private.project_role_of(v_project,v_target) in ('owner','admin')) then v_count:=0; end if;
    select * into v_existing from public.task_members where task_id=p_task_id and user_id=v_target for update;
    if v_existing.is_direct then v_count:=0; end if;
  end if;
  if v_count<>1 or v_target is null then
    perform set_config('response.status','400',true);
    return jsonb_build_object('code','TT_MEMBER_LOOKUP','message','Не удалось добавить участника по указанному идентификатору.','details',null,'hint',null);
  end if;
  insert into public.task_members(task_id,user_id,set_by,role_override,is_direct)
    values(p_task_id,v_target,v_actor,p_role,true)
    on conflict(task_id,user_id) do update set role_override=excluded.role_override,is_direct=true,set_by=excluded.set_by,set_at=now();
  insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data,new_data)
    values(v_project,v_actor,'access_approved','task_member',v_target,
      jsonb_build_object('task_id',p_task_id,'role_override',v_existing.role_override),
      jsonb_build_object('task_id',p_task_id,'role_override',p_role,'is_direct',true));
  return jsonb_build_object('success',true);
end $$;

create function public.remove_task_member(p_task_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_inherited public.project_role; v_old public.task_members%rowtype;
begin
  v_inherited := private.lock_task_membership_management(p_task_id,p_user_id);
  select * into v_old from public.task_members where task_id=p_task_id and user_id=p_user_id for update;
  if not coalesce(v_old.is_direct,false) then return; end if;
  if v_inherited is null then
    perform public.remove_task_assignee(p_task_id,p_user_id);
    delete from public.task_members where task_id=p_task_id and user_id=p_user_id;
  else
    update public.task_members set is_direct=false,role_override=null,set_by=auth.uid(),set_at=now()
      where task_id=p_task_id and user_id=p_user_id;
  end if;
  insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data,new_data)
    values(private.task_project_id(p_task_id),auth.uid(),'access_revoked','task_member',p_user_id,
      jsonb_build_object('task_id',p_task_id,'role_override',v_old.role_override,'is_direct',true),
      jsonb_build_object('task_id',p_task_id,'inherited_role',v_inherited,'is_direct',false));
end $$;

create or replace function public.add_task_assignee(p_task_id uuid,p_user_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := private.require_auth(); v_project public.projects%rowtype; v_task public.tasks%rowtype;
  v_actor_role public.project_role;
begin
  v_project := private.lock_project_state(private.task_project_id(p_task_id));
  v_task := private.lock_task(p_task_id);
  v_actor_role := private.lock_project_role(v_project.id,v_actor);
  if v_actor_role is null or v_actor_role not in ('owner','admin') then
    raise exception 'only owner/admin can manage assignees' using errcode='42501';
  end if;
  if v_project.status<>'active' or v_task.status='archived' then raise exception 'task is archived'; end if;
  if private.lock_task_role(p_task_id,v_project.id,p_user_id) is null then raise exception 'assignee must have stage access'; end if;
  insert into public.task_assignees(task_id,user_id,assigned_by) values(p_task_id,p_user_id,v_actor) on conflict do nothing;
  if not found then return; end if;
  insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,new_data)
    values(v_project.id,v_actor,'assignee_added','task_assignee',p_user_id,jsonb_build_object('task_id',p_task_id,'user_id',p_user_id));
end $$;

-- Optimistic update for the current editor; old clients retain their signature.
create function public.update_task(p_task_id uuid,p_title text,p_description text,p_expected_title text,p_expected_description text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_task public.tasks%rowtype; v_actor uuid := private.require_auth();
begin
  perform private.lock_project_state(private.task_project_id(p_task_id));
  v_task := private.lock_task(p_task_id);
  if not private.is_project_admin(v_task.project_id,v_actor) then raise exception 'only owner/admin can edit stage details' using errcode='42501'; end if;
  if v_task.title is distinct from p_expected_title or coalesce(v_task.description,'') is distinct from coalesce(p_expected_description,'') then
    if v_task.title=btrim(p_title) and v_task.description is not distinct from nullif(btrim(p_description),'') then return; end if;
    raise exception 'Этап изменён другим участником. Обновите данные и проверьте сохранённый черновик.' using errcode='PT409';
  end if;
  perform public.update_task(p_task_id,p_title,p_description);
end $$;

revoke all on function private.lock_task_membership_management(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.get_task_project_context(uuid),public.list_task_participants(uuid),
  public.add_task_member_by_identifier(uuid,text,public.project_role),public.remove_task_member(uuid,uuid),
  public.update_task(uuid,text,text,text,text) from public,anon,service_role;
grant execute on function public.get_task_project_context(uuid),public.list_task_participants(uuid),
  public.add_task_member_by_identifier(uuid,text,public.project_role),public.remove_task_member(uuid,uuid),
  public.update_task(uuid,text,text,text,text) to authenticated;
-- Extend the existing notification, Broadcast and bootstrap mechanisms.
create or replace function private.audit_to_notification()
returns trigger
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_task_id uuid;
    v_type public.notification_type;
    v_title text;
    v_body text;
    v_recipient uuid;
    v_project_name text;
    v_task_title text;
    v_item_title text;
    v_person_name text;
    v_change_summary text;
    v_role_label text;
    v_actor uuid := coalesce(new.user_id, '00000000-0000-0000-0000-000000000000'::uuid);
begin
    if new.action in ('access_approved','access_revoked') and new.entity_type = 'task_member' then
        v_type := case when new.action='access_approved' then 'task_member_added'::public.notification_type else 'task_member_removed'::public.notification_type end;
        v_recipient := new.entity_id;
        v_task_id := nullif(new.new_data->>'task_id','')::uuid;
        v_title := case when new.action='access_approved' then 'Вы добавлены в этап' else 'Прямое участие в этапе удалено' end;
    elsif new.action = 'role_changed' and new.entity_type = 'task_member' then
        v_type := 'task_role_changed';
        v_recipient := new.entity_id;
        v_task_id := nullif(new.new_data->>'task_id', '')::uuid;
        v_title := 'Права чек-листа изменены';
    elsif new.action = 'assignee_added' then
        v_type := 'task_assigned';
        v_recipient := new.entity_id;
        v_task_id := nullif(new.new_data->>'task_id', '')::uuid;
        v_title := 'Вас назначили исполнителем';
    elsif new.action = 'assignee_removed' then
        v_type := 'task_unassigned';
        v_recipient := new.entity_id;
        v_task_id := nullif(new.new_data->>'task_id', '')::uuid;
        v_title := 'Назначение снято';
    elsif new.action in ('checked', 'unchecked') then
        v_type := case when new.action = 'checked'
                       then 'task_item_checked' else 'task_item_unchecked' end;
        v_title := case when new.action = 'checked'
                        then 'Пункт отмечен' else 'Отметка пункта снята' end;
        select task_id, title into v_task_id, v_item_title
          from public.task_items where id = new.entity_id;
    elsif new.action = 'updated'
      and new.entity_type = 'task_item'
      and (new.new_data ? 'title'
        or new.new_data ? 'description'
        or new.new_data ? 'position'
        or new.new_data ? 'percentage'
        or new.new_data ? 'comment'
        or new.new_data ? 'is_completed') then
        v_type := 'task_item_changed';
        v_title := 'Изменён пункт чек-листа';
        select task_id, title into v_task_id, v_item_title
          from public.task_items where id = new.entity_id;
    elsif new.action = 'archived' and new.entity_type = 'project' then
        v_type := 'project_archived';
        v_title := 'Проект архивирован';
    elsif new.action = 'restored' and new.entity_type = 'project' then
        v_type := 'project_restored';
        v_title := 'Проект восстановлен';
    elsif new.action = 'archived' and new.entity_type = 'task' then
        v_type := 'task_archived';
        v_task_id := new.entity_id;
        v_title := 'Этап архивирован';
    elsif new.action = 'restored' and new.entity_type = 'task' then
        v_type := 'task_restored';
        v_task_id := new.entity_id;
        v_title := 'Этап восстановлен';
    else
        return new;
    end if;

    if new.entity_type = 'project' and new.action in ('archived', 'restored') then
        select name into v_project_name from public.projects where id = new.project_id;
        v_body := format(
            'Проект «%s» %s.',
            coalesce(v_project_name, 'Без названия'),
            case when new.action = 'archived' then 'архивирован' else 'восстановлен' end
        );
        for v_recipient in
            select pm.user_id from public.project_members pm where pm.project_id=new.project_id and pm.user_id<>v_actor
        loop
            perform private.create_notification(
                v_recipient,
                new.project_id,
                null,
                v_type,
                v_title,
                v_body,
                jsonb_build_object('project_id', new.project_id),
                'audit:' || new.id::text
            );
        end loop;
        return new;
    end if;

    if v_task_id is null then return new; end if;
    select p.name, t.title
      into v_project_name, v_task_title
      from public.tasks t
      join public.projects p on p.id = t.project_id
     where t.id = v_task_id;
    v_project_name := coalesce(v_project_name, 'Без названия');
    v_task_title := coalesce(v_task_title, 'Без названия');

    if new.action in ('archived', 'restored') and new.entity_type = 'task' then
        v_body := format(
            'Этап «%s» в проекте «%s» %s.',
            v_task_title,
            v_project_name,
            case when new.action = 'archived' then 'архивирован' else 'восстановлен' end
        );
        for v_recipient in
            select s.user_id from (select pm.user_id from public.project_members pm where pm.project_id=new.project_id
     union select tm.user_id from public.task_members tm where tm.task_id=v_task_id and tm.is_direct) s where s.user_id<>v_actor
        loop
            perform private.create_notification(
                v_recipient,
                new.project_id,
                v_task_id,
                v_type,
                v_title,
                v_body,
                jsonb_build_object('task_id', v_task_id, 'project_name', v_project_name, 'task_title', v_task_title),
                'audit:' || new.id::text
            );
        end loop;
        return new;
    end if;

    if new.action in ('access_approved','access_revoked') and new.entity_type='task_member' then
        v_body := format('Этап «%s» в проекте «%s». %s', v_task_title,v_project_name,
          case when new.action='access_approved' then 'Предоставлен прямой доступ только к этому этапу.'
            when new.new_data->>'inherited_role' is not null then 'Прямое участие удалено. Доступ по роли проекта сохранён.'
            else 'Доступ к этапу отозван.' end);
    elsif new.action = 'role_changed' and new.entity_type = 'task_member' then
        if new.new_data->>'role_override' is null then
            v_body := format(
                'Права чек-листа этапа «%s» снова наследуются от роли в проекте «%s».',
                v_task_title,
                v_project_name
            );
        else
            v_role_label := case new.new_data->>'role_override'
                when 'admin' then 'Администратор чек-листа'
                when 'member' then 'Участник'
                when 'viewer' then 'Только просмотр'
                else new.new_data->>'role_override'
            end;
            v_body := format(
                'Для чек-листа этапа «%s» в проекте «%s» установлена роль «%s».',
                v_task_title,
                v_project_name,
                v_role_label
            );
        end if;
    elsif new.action = 'assignee_added' then
        v_body := format(
            'Вы назначены исполнителем этапа «%s» в проекте «%s».',
            v_task_title,
            v_project_name
        );
    elsif new.action = 'assignee_removed' then
        v_body := format(
            'С вас снято назначение на этапе «%s» проекта «%s».',
            v_task_title,
            v_project_name
        );
    elsif new.action in ('checked', 'unchecked') then
        v_body := format(
            '«%s» → этап «%s» → проект «%s».',
            coalesce(v_item_title, 'Пункт чек-листа'),
            v_task_title,
            v_project_name
        );
    else
        v_change_summary := concat_ws(', ',
            case when new.new_data ? 'title' then 'название' end,
            case when new.new_data ? 'description' then 'описание' end,
            case when new.new_data ? 'position' then 'порядок' end,
            case when new.new_data ? 'percentage'
                 then format('прогресс %s%%', new.new_data->>'percentage') end,
            case when new.new_data ? 'comment' then 'комментарий' end,
            case when new.new_data ? 'is_completed'
                       and not (new.new_data ? 'percentage') then 'состояние' end
        );
        v_body := format(
            'Пункт «%s» изменён (%s) на этапе «%s» проекта «%s».',
            coalesce(v_item_title, 'Пункт чек-листа'),
            coalesce(v_change_summary, 'данные'),
            v_task_title,
            v_project_name
        );
    end if;

    if new.action in ('checked', 'unchecked', 'updated') then
        for v_recipient in
            select s.user_id from (select pm.user_id from public.project_members pm where pm.project_id=new.project_id
     union select tm.user_id from public.task_members tm where tm.task_id=v_task_id and tm.is_direct) s
     where s.user_id<>v_actor and private.has_task_access(v_task_id,s.user_id)
        loop
            perform private.create_notification(
                v_recipient,
                new.project_id,
                v_task_id,
                v_type,
                v_title,
                v_body,
                jsonb_build_object('task_id', v_task_id, 'entity_id', new.entity_id, 'project_name', v_project_name, 'task_title', v_task_title),
                'audit:' || new.id::text
            );
        end loop;
    elsif v_recipient is not null and v_recipient <> v_actor then
        perform private.create_notification(
            v_recipient,
            new.project_id,
            v_task_id,
            v_type,
            v_title,
            v_body,
            jsonb_build_object('task_id', v_task_id, 'project_name', v_project_name, 'task_title', v_task_title),
            'audit:' || new.id::text
        );
    end if;
    return new;
end;
$$;

create or replace function private.emit_checklist_deadline_event(p_item_id uuid, p_event text,
    p_previous_deadline timestamptz default null, p_actor uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
    v_item public.task_items%rowtype;
    v_project uuid;
    v_project_name text;
    v_task_name text;
    v_number bigint;
    v_audit bigint;
    v_title text;
    v_data jsonb;
    v_recipient uuid;
begin
    select * into v_item from public.task_items where id = p_item_id;
    if not found then return; end if;
    select t.project_id, t.title, p.name into v_project, v_task_name, v_project_name
      from public.tasks t join public.projects p on p.id = t.project_id where t.id = v_item.task_id;
    update private.checklist_deadline_state set event_number = event_number + 1
      where item_id = p_item_id returning event_number into v_number;
    v_title := case p_event
      when 'set' then 'Установлен дедлайн'
      when 'changed' then 'Дедлайн изменён'
      when 'removed' then 'Дедлайн удалён'
      when 'urgent' then 'Горящий дедлайн'
      when 'overdue' then 'Просрочен дедлайн'
      when 'completed' then 'Чек-лист с предупреждением выполнен'
      when 'reopened_urgent' then 'Снова горящий дедлайн'
      when 'reopened_overdue' then 'Снова просрочен дедлайн'
      else 'Состояние дедлайна изменено' end;
    v_data := pg_catalog.jsonb_build_object('task_id', v_item.task_id,
      'entity_id', p_item_id, 'item_id', p_item_id, 'deadline_event', p_event,
      'deadline_at', v_item.deadline_at, 'previous_deadline_at', p_previous_deadline,
      'title', v_item.title, 'task_title', v_task_name, 'project_name', v_project_name,
      'event_number', v_number);
    -- The existing generic audit notifier ignores this entity type; the
    -- deadline event owns its single notification fanout below.
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
      values (v_project, p_actor, 'updated', 'task_item_deadline', p_item_id,
        pg_catalog.jsonb_build_object('deadline_at', p_previous_deadline), v_data)
      returning id into v_audit;
    for v_recipient in select s.user_id from (select pm.user_id from public.project_members pm where pm.project_id=v_project
     union select tm.user_id from public.task_members tm where tm.task_id=v_item.task_id and tm.is_direct) s
     where private.has_task_access(v_item.task_id,s.user_id)
    loop
      perform private.create_notification(v_recipient, v_project, v_item.task_id, 'task_item_changed',
        v_title, pg_catalog.format('Чек-лист «%s» → этап «%s» → проект «%s». %s',
          v_item.title, v_task_name, v_project_name,
          case when v_item.deadline_at is null then 'Дедлайн удалён.'
            else 'Срок: ' || pg_catalog.to_char(v_item.deadline_at at time zone 'UTC', 'DD.MM.YYYY HH24:MI') || ' UTC.' end),
        v_data, 'deadline:audit:' || v_audit::text);
    end loop;
end;
$$;

create or replace function private.broadcast_application_invalidation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
    v_project_id uuid;
    v_task_id uuid;
    v_user_id uuid;
    v_recipient uuid;
    v_payload jsonb := jsonb_build_object('table', tg_table_name, 'operation', tg_op);
begin
    if tg_table_name = 'projects' then
        v_project_id := nullif(v_row->>'id', '')::uuid;
    elsif tg_table_name = 'project_members' then
        v_project_id := nullif(v_row->>'project_id', '')::uuid;
        v_user_id := nullif(v_row->>'user_id', '')::uuid;
    elsif tg_table_name = 'tasks' then
        v_project_id := nullif(v_row->>'project_id', '')::uuid;
        v_task_id := nullif(v_row->>'id', '')::uuid;
    elsif tg_table_name = 'task_items' then
        v_task_id := nullif(v_row->>'task_id', '')::uuid;
        select t.project_id into v_project_id
          from public.tasks t where t.id = v_task_id;
    elsif tg_table_name in ('task_members', 'task_assignees') then
        v_task_id := nullif(v_row->>'task_id', '')::uuid;
        v_user_id := nullif(v_row->>'user_id', '')::uuid;
        select t.project_id into v_project_id
          from public.tasks t where t.id = v_task_id;
    elsif tg_table_name = 'notifications' then
        v_user_id := nullif(v_row->>'user_id', '')::uuid;
    else
        return null;
    end if;

    if v_project_id is not null then
        perform realtime.send(v_payload, 'invalidate', 'project:' || v_project_id::text, true);
    end if;
    if v_task_id is not null then
        perform realtime.send(v_payload, 'invalidate', 'task:' || v_task_id::text, true);
    end if;
    if v_user_id is not null then
        perform realtime.send(v_payload, 'invalidate', 'user:' || v_user_id::text, true);
    end if;
    if tg_table_name = 'projects' and v_project_id is not null and tg_op <> 'DELETE' then
        -- Stage-only clients never join the project's private topic. Send the
        -- same opaque invalidation through each existing stage topic instead.
        for v_recipient in select t.id from public.tasks t where t.project_id=v_project_id loop
            perform realtime.send(v_payload, 'invalidate', 'task:' || v_recipient::text, true);
        end loop;
        for v_recipient in
            select s.user_id from (select pm.user_id from public.project_members pm where pm.project_id=v_project_id
    union select tm.user_id from public.task_members tm join public.tasks t on t.id=tm.task_id
      where t.project_id=v_project_id and tm.is_direct) s where s.user_id is distinct from v_user_id
        loop
            perform realtime.send(v_payload, 'invalidate', 'user:' || v_recipient::text, true);
        end loop;
    elsif tg_table_name in ('tasks', 'task_items') and v_task_id is not null then
        for v_recipient in
            select s.user_id from (select pm.user_id from public.project_members pm where pm.project_id=v_project_id
    union select tm.user_id from public.task_members tm where tm.task_id=v_task_id and tm.is_direct) s
    where private.has_task_access(v_task_id,s.user_id) and s.user_id is distinct from v_user_id
        loop
            perform realtime.send(v_payload, 'invalidate', 'user:' || v_recipient::text, true);
        end loop;
    end if;
    return null;
end;
$$;

create or replace function private.offline_account_rows(p_dataset text, p_snapshot_at timestamptz)
returns table (row_key text, row_data jsonb)
language plpgsql stable security invoker set search_path = '' set timezone = 'UTC' as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  case p_dataset
  when 'profile' then
    return query select p.id::text, to_jsonb(p) from public.profiles p where p.id = auth.uid();
  when 'projects' then
    return query select p.id::text, to_jsonb(p) || jsonb_build_object('role', m.role)
      from public.projects p join public.project_members m on m.project_id = p.id and m.user_id = auth.uid();
  when 'members' then
    return query select m.project_id::text || ':' || m.user_id::text, to_jsonb(m) from public.project_members m;
  when 'profiles' then
    return query select p.id::text, to_jsonb(p) from public.profiles p
      where p.id = auth.uid() or exists (select 1 from public.project_members m where m.user_id = p.id)
        or exists (select 1 from public.task_assignees a where a.user_id = p.id);
  when 'tasks' then
    return query select t.id::text, to_jsonb(t) from public.tasks t;
  when 'roles' then
    return query select t.id::text, jsonb_build_object('task_id', t.id, 'role', public.get_my_task_role(t.id), 'project_context',public.get_task_project_context(t.id), 'participants',(select coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) from public.list_task_participants(t.id) p)) from public.tasks t;
  when 'overrides' then
    return query select m.task_id::text || ':' || m.user_id::text,
      jsonb_build_object('task_id', m.task_id, 'user_id', m.user_id, 'role_override', m.role_override, 'set_by', m.set_by, 'set_at', m.set_at)
      from public.task_members m join public.tasks t on t.id = m.task_id
      join public.project_members pm on pm.project_id = t.project_id and pm.user_id = auth.uid()
      where pm.role in ('owner', 'admin') and m.role_override is not null;
  when 'assignees' then
    return query select a.task_id::text || ':' || a.user_id::text, to_jsonb(a) from public.task_assignees a;
  when 'items' then
    return query select i.id::text, to_jsonb(i) from public.task_items i;
  when 'templates' then
    return query select t.id::text, to_jsonb(t) from public.list_task_templates() t;
  when 'template_items' then
    return query select i.id::text, to_jsonb(i) || jsonb_build_object('position', i.template_position)
      from public.list_task_templates() t cross join lateral public.list_task_template_items(t.id) i;
  when 'daily_audit' then
    return query select lpad(a.id::text, 20, '0'), to_jsonb(a) from public.audit_log a
      where a.entity_type = 'task_item'
        and a.created_at >= date_trunc('day', p_snapshot_at at time zone 'Etc/GMT-3') at time zone 'Etc/GMT-3'
        and a.created_at <= p_snapshot_at;
  when 'history' then
    return query select lpad(a.id::text, 20, '0'), to_jsonb(a) from public.audit_log a
      where a.project_id is not null and a.created_at >= p_snapshot_at - interval '90 days'
        and a.created_at <= p_snapshot_at;
  when 'notifications' then
    return query select n.id::text, to_jsonb(n) from public.notifications n where n.user_id = auth.uid() and n.created_at <= p_snapshot_at and
      (not n.is_read or n.id in (select r.id from public.notifications r where r.user_id = auth.uid() and r.is_read and r.created_at <= p_snapshot_at
        order by r.created_at desc, r.id desc limit 100));
  when 'last_editors' then
    return query select e.task_item_id::text, to_jsonb(e) || jsonb_build_object('task_id', t.id)
      from public.tasks t cross join lateral public.list_task_item_last_editors(t.id) e;
  else raise exception 'unknown offline dataset' using errcode = '22023';
  end case;
end $$;
-- The invoker view keeps source-table RLS. Parent status is the same minimal,
-- authorized context used by the stage route; the project row remains private.
create or replace view public.checklist_overview with (security_invoker = true) as
select i.id,i.task_id,t.project_id,i.percentage,i.is_completed,i.comment,i.deadline_at,i.sync_version
from public.task_items i join public.tasks t on t.id=i.task_id
where not i.is_archived and t.status<>'archived'
  and public.get_task_project_context(t.id)->>'status'='active';
notify pgrst, 'reload schema';
commit;
