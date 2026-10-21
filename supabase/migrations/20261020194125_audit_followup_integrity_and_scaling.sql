-- Additive RPC contracts; legacy clients retain their existing signatures.
begin;
set local lock_timeout = '5s';

create function private.lock_task_item_version(p_id uuid, p_version bigint)
returns public.task_items language plpgsql security definer set search_path = '' as $$
declare v_user uuid := private.require_auth(); v_task uuid; v_project uuid;
  v_role public.project_role; v_item public.task_items%rowtype;
begin
  select task_id into v_task from public.task_items where id=p_id;
  if v_task is null then raise exception 'no access to task item' using errcode='42501'; end if;
  v_project := private.task_project_id(v_task);
  perform private.lock_project_state(v_project);
  perform private.lock_task(v_task);
  v_role := private.lock_task_role(v_task,v_project,v_user);
  select * into v_item from public.task_items where id=p_id for update;
  if not found or v_role is null or v_role not in ('owner','admin','member') then
    raise exception 'no access to task item' using errcode='42501'; end if;
  if p_version is null or p_version < 1 then raise exception 'expected version required' using errcode='22023'; end if;
  if v_item.sync_version <> p_version then
    raise exception 'Пункт изменён другим участником. Ваш черновик сохранён.' using errcode='PT409'; end if;
  return v_item;
end $$;
revoke all on function private.lock_task_item_version(uuid,bigint) from public,anon,authenticated,service_role;

create function public.update_task_item(p_task_item_id uuid,p_title text,p_expected_version bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.lock_task_item_version(p_task_item_id,p_expected_version);
  perform public.update_task_item(p_task_item_id,p_title,null::text,null::numeric);
end $$;
create function public.set_task_item_comment(p_task_item_id uuid,p_comment text,p_expected_version bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.lock_task_item_version(p_task_item_id,p_expected_version);
  perform public.set_task_item_comment(p_task_item_id,p_comment);
end $$;
create function public.set_task_item_percentage(p_task_item_id uuid,p_percentage integer,p_expected_version bigint)
returns integer language plpgsql security definer set search_path='' as $$
begin
  perform private.lock_task_item_version(p_task_item_id,p_expected_version);
  return public.set_task_item_percentage(p_task_item_id,p_percentage);
end $$;
create function public.set_task_item_state(p_task_item_id uuid,p_completed boolean,p_expected_version bigint)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform private.lock_task_item_version(p_task_item_id,p_expected_version);
  return public.set_task_item_state(p_task_item_id,p_completed);
end $$;
revoke all on function public.update_task_item(uuid,text,bigint),public.set_task_item_comment(uuid,text,bigint),
  public.set_task_item_percentage(uuid,integer,bigint),public.set_task_item_state(uuid,boolean,bigint) from public,anon,service_role;
grant execute on function public.update_task_item(uuid,text,bigint),public.set_task_item_comment(uuid,text,bigint),
  public.set_task_item_percentage(uuid,integer,bigint),public.set_task_item_state(uuid,boolean,bigint) to authenticated;

-- All editable fields participate in the existing version/feed protocol.
create or replace function private.bump_task_item_sync_version()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if current_setting('tasktrace.force_sync_version_bump',true)='on'
    or (to_jsonb(new)-array['sync_version','updated_at']) is distinct from (to_jsonb(old)-array['sync_version','updated_at']) then
    new.sync_version := old.sync_version+1;
  else new.sync_version := old.sync_version; end if;
  return new;
end $$;

-- The existing commit-ordered feed is also the snapshot revision. No partial
-- list is published: clients validate all pages and retry PT409 as one unit.
create function public.get_task_item_snapshot_page(p_task_id uuid,p_mode text default 'all',
  p_offset integer default 0,p_limit integer default 500,p_revision bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := private.require_auth(); v_revision bigint; v_total bigint; v_rows jsonb;
begin
  if p_mode is null or p_mode not in ('all','active','archived') or p_offset is null or p_offset<0
    or p_limit is null or p_limit not between 1 and 500 then raise exception 'invalid snapshot page' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(29175,5);
  if not private.has_task_access(p_task_id,v_user) then raise exception 'no access to task' using errcode='42501'; end if;
  select coalesce(max(cursor),0) into v_revision from private.task_item_sync_changes;
  if p_revision is not null and p_revision<>v_revision then raise exception 'Snapshot changed between pages' using errcode='PT409'; end if;
  select count(*) into v_total from public.task_items i where i.task_id=p_task_id
    and (p_mode='all' or i.is_archived=(p_mode='archived'));
  select coalesce(jsonb_agg(to_jsonb(page) order by page.position,page.id),'[]') into v_rows
    from (select i.* from public.task_items i where i.task_id=p_task_id
      and (p_mode='all' or i.is_archived=(p_mode='archived')) order by i.position,i.id limit p_limit offset p_offset) page;
  return jsonb_build_object('revision',v_revision,'total',v_total,'offset',p_offset,'rows',v_rows);
end $$;
revoke all on function public.get_task_item_snapshot_page(uuid,text,integer,integer,bigint) from public,anon,service_role;
grant execute on function public.get_task_item_snapshot_page(uuid,text,integer,integer,bigint) to authenticated;

-- Immutable parent links survive item deletion. Backfill from current rows and
-- trusted immutable creation/removal snapshots without rewriting audit events.
create table private.audit_item_parents(item_id uuid primary key,task_id uuid not null,project_id uuid not null);
alter table private.audit_item_parents enable row level security;
revoke all on private.audit_item_parents from public,anon,authenticated,service_role;
insert into private.audit_item_parents select i.id,i.task_id,t.project_id from public.task_items i join public.tasks t on t.id=i.task_id;
insert into private.audit_item_parents(item_id,task_id,project_id)
select a.entity_id,t.id,t.project_id from public.audit_log a join public.tasks t
  on t.id::text=coalesce(a.new_data->>'task_id',a.old_data->>'task_id') and t.project_id=a.project_id
where a.entity_type in ('task_item','task_item_deadline') and a.entity_id is not null
on conflict(item_id) do nothing;
create function private.link_task_item_audit()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_task uuid; v_project uuid;
begin
  if new.entity_type not in ('task_item','task_item_deadline') then return new; end if;
  select i.task_id,t.project_id into v_task,v_project from public.task_items i join public.tasks t on t.id=i.task_id where i.id=new.entity_id;
  if v_task is null then
    select t.id,t.project_id into v_task,v_project from public.tasks t
      where t.id::text=coalesce(new.new_data->>'task_id',new.old_data->>'task_id') and t.project_id=new.project_id;
  end if;
  if v_task is not null and v_project=new.project_id then
    insert into private.audit_item_parents values(new.entity_id,v_task,v_project) on conflict(item_id) do nothing;
    if new.old_data is not null then new.old_data := new.old_data||jsonb_build_object('task_id',v_task); end if;
    if new.new_data is not null then new.new_data := new.new_data||jsonb_build_object('task_id',v_task); end if;
  end if;
  return new;
end $$;
revoke all on function private.link_task_item_audit() from public,anon,authenticated,service_role;
create trigger trg_audit_item_parent before insert on public.audit_log for each row execute function private.link_task_item_audit();

-- Constant-size generation/count metadata replaces full JSON hashing per page.
create table private.template_read_state(scope text primary key,revision bigint not null default 1,total bigint not null default 0 check(total>=0));
alter table private.template_read_state enable row level security;
revoke all on private.template_read_state from public,anon,authenticated,service_role;
insert into private.template_read_state(scope,total) select 'library',count(*) from public.task_templates where archived_at is null;
insert into private.template_read_state(scope,total) select 'template:'||t.id,count(i.id) from public.task_templates t left join public.task_template_items i on i.template_id=t.id group by t.id;
create function private.track_template_read_state()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_delta bigint;
begin
  if tg_table_name='task_templates' then
    v_delta := case when tg_op<>'DELETE' and new.archived_at is null then 1 else 0 end
      -case when tg_op<>'INSERT' and old.archived_at is null then 1 else 0 end;
    update private.template_read_state set revision=revision+1,total=total+v_delta where scope='library';
    if tg_op='INSERT' then insert into private.template_read_state(scope) values('template:'||new.id) on conflict do nothing; end if;
  else
    v_id := case when tg_op='DELETE' then old.template_id else new.template_id end;
    v_delta := case tg_op when 'INSERT' then 1 when 'DELETE' then -1 else 0 end;
    update private.template_read_state set revision=revision+1,total=total+v_delta where scope='template:'||v_id;
    update private.template_read_state set revision=revision+1 where scope='library';
  end if;
  return null;
end $$;
revoke all on function private.track_template_read_state() from public,anon,authenticated,service_role;
create trigger trg_template_read_state after insert or update or delete on public.task_templates for each row execute function private.track_template_read_state();
create trigger trg_template_item_read_state after insert or update or delete on public.task_template_items for each row execute function private.track_template_read_state();
create index task_templates_read_page on public.task_templates(created_at desc,id) where archived_at is null;
create index task_template_items_read_page on public.task_template_items(template_id,position,created_at,id);

create function public.get_task_template_page_v2(p_template_id uuid default null,p_offset integer default 0,
  p_limit integer default 500,p_revision text default null,p_after jsonb default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_user uuid := private.require_auth(); v_revision text; v_total bigint; v_rows jsonb; v_next jsonb;
begin
  if p_offset is null or p_offset<0 or p_limit is null or p_limit not between 1 and 500 then raise exception 'invalid template page' using errcode='22023'; end if;
  if p_template_id is not null and not exists(select 1 from public.task_templates where id=p_template_id and archived_at is null) then raise exception 'template not found' using errcode='PT404'; end if;
  select revision::text,total into v_revision,v_total from private.template_read_state
    where scope=case when p_template_id is null then 'library' else 'template:'||p_template_id end;
  if p_revision is not null and p_revision<>v_revision then raise exception 'Template changed between pages' using errcode='PT409'; end if;
  if p_template_id is null then
    with page as materialized (select t.id,t.name,t.description,t.created_by,t.created_at,t.updated_at,
      (select count(*) from public.task_template_items i where i.template_id=t.id) item_count
      from public.task_templates t where t.archived_at is null and (p_after is null or
        t.created_at<(p_after->>'created_at')::timestamptz or (t.created_at=(p_after->>'created_at')::timestamptz and t.id>(p_after->>'id')::uuid))
      order by t.created_at desc,t.id limit p_limit offset case when p_after is null then p_offset else 0 end)
    select coalesce(jsonb_agg(to_jsonb(page) order by created_at desc,id),'[]') into v_rows from page;
  else
    with page as materialized (select i.id,i.template_id,i.title,i.description,i.position template_position,i.created_at,i.updated_at
      from public.task_template_items i where i.template_id=p_template_id and (p_after is null or
        (i.position,i.created_at,i.id)>((p_after->>'template_position')::numeric,(p_after->>'created_at')::timestamptz,(p_after->>'id')::uuid))
      order by i.position,i.created_at,i.id limit p_limit offset case when p_after is null then p_offset else 0 end)
    select coalesce(jsonb_agg(to_jsonb(page) order by template_position,created_at,id),'[]') into v_rows from page;
  end if;
  v_next := v_rows->(jsonb_array_length(v_rows)-1);
  return jsonb_build_object('revision',v_revision,'total',v_total,'offset',p_offset,'rows',v_rows,'next',
    case when v_next is null then null else jsonb_strip_nulls(jsonb_build_object('id',v_next->'id','created_at',v_next->'created_at','template_position',v_next->>'template_position')) end);
end $$;
revoke all on function public.get_task_template_page_v2(uuid,integer,integer,text,jsonb) from public,anon,service_role;
grant execute on function public.get_task_template_page_v2(uuid,integer,integer,text,jsonb) to authenticated;
create or replace function public.get_task_template_page(p_template_id uuid default null,p_offset integer default 0,
  p_limit integer default 500,p_revision text default null)
returns jsonb language sql stable security definer set search_path='' as $$
  select public.get_task_template_page_v2(p_template_id,p_offset,p_limit,p_revision,null)
$$;

-- One status aggregation per affected task and statement. All row-level audit,
-- version, feed and notification triggers remain active for bulk inserts.
drop trigger trg_task_items_recalculate_status on public.task_items;
create function private.recalculate_task_status_statement()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  if tg_op='INSERT' then
    for v_id in select distinct task_id from new_items order by task_id loop perform private.recalculate_task_status(v_id); end loop;
  elsif tg_op='DELETE' then
    for v_id in select distinct task_id from old_items order by task_id loop perform private.recalculate_task_status(v_id); end loop;
  else
    for v_id in select distinct n.task_id from new_items n join old_items o on o.id=n.id
      where (n.percentage,n.is_completed,n.is_archived) is distinct from (o.percentage,o.is_completed,o.is_archived)
      order by n.task_id loop perform private.recalculate_task_status(v_id); end loop;
  end if;
  return null;
end $$;
revoke all on function private.recalculate_task_status_statement() from public,anon,authenticated,service_role;
create trigger trg_task_items_status_insert after insert on public.task_items referencing new table as new_items for each statement execute function private.recalculate_task_status_statement();
create trigger trg_task_items_status_update after update on public.task_items referencing old table as old_items new table as new_items for each statement execute function private.recalculate_task_status_statement();
create trigger trg_task_items_status_delete after delete on public.task_items referencing old table as old_items for each statement execute function private.recalculate_task_status_statement();

create or replace function private.audit_log_visible(p_project_id uuid, p_entity_type text,
  p_entity_id uuid, p_old_data jsonb, p_new_data jsonb)
returns boolean language plpgsql stable security definer set search_path = private, public as $$
declare v_task_id uuid; v_template_id uuid;
begin
  if p_entity_type = 'profile' then return p_entity_id = auth.uid(); end if;
  if p_entity_type = 'task_template' then
    return exists(select 1 from public.task_templates tt where tt.id=p_entity_id and tt.created_by=auth.uid())
      or coalesce(p_new_data->>'created_by',p_old_data->>'created_by')=auth.uid()::text;
  end if;
  if p_entity_type = 'task_template_item' then
    select template_id into v_template_id from public.task_template_items where id=p_entity_id;
    if v_template_id is null then
      begin v_template_id := nullif(coalesce(p_new_data->>'template_id',p_old_data->>'template_id'),'')::uuid;
      exception when invalid_text_representation then return false; end;
    end if;
    return exists(select 1 from public.task_templates tt where tt.id=v_template_id and tt.created_by=auth.uid());
  end if;
  if p_project_id is not null and private.is_project_admin(p_project_id) then return true; end if;
  if p_entity_type in ('project','project_member') then
    return p_project_id is not null and private.is_project_member(p_project_id);
  end if;
  if p_entity_type in ('task','task_from_template') then
    return p_entity_id is not null and private.task_project_id(p_entity_id)=p_project_id and private.has_task_access(p_entity_id);
  end if;
  if p_entity_type in ('task_item','task_item_deadline') then
    select task_id into v_task_id from public.task_items where id=p_entity_id;
    -- Audit payloads are immutable and server-generated. Retain history after
    -- item deletion, but still require the surviving task and its current ACL.
    if v_task_id is null then
      select task_id into v_task_id from private.audit_item_parents where item_id=p_entity_id and project_id=p_project_id;
    end if;
    if v_task_id is null then
      begin v_task_id := nullif(coalesce(p_new_data->>'task_id',p_old_data->>'task_id'),'')::uuid;
      exception when invalid_text_representation then return false; end;
    end if;
    return v_task_id is not null and private.task_project_id(v_task_id)=p_project_id and private.has_task_access(v_task_id);
  end if;
  if p_entity_type in ('task_member','task_assignee') then
    begin v_task_id := nullif(coalesce(p_new_data->>'task_id',p_old_data->>'task_id'),'')::uuid;
    exception when invalid_text_representation then return false; end;
    return v_task_id is not null and private.task_project_id(v_task_id)=p_project_id and private.has_task_access(v_task_id);
  end if;
  return false;
end; $$;

create or replace function public.transfer_project_ownership(
    p_project_id uuid,
    p_new_owner_id uuid
)
returns void
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_project public.projects%rowtype;
    v_actor_role public.project_role;
    v_new_role public.project_role;
    v_override record;
begin
    v_project := private.lock_project_state(p_project_id);
    v_actor_role := private.lock_project_role(p_project_id, v_user);
    v_new_role := private.lock_project_role(p_project_id, p_new_owner_id);
    if v_actor_role is distinct from 'owner'::public.project_role then
        raise exception 'only the current owner can transfer ownership'
            using errcode = 'insufficient_privilege';
    end if;
    if p_new_owner_id = v_user then
        raise exception 'cannot transfer ownership to yourself';
    end if;
    if v_new_role is null then
        raise exception 'new owner must be a project member';
    end if;
    if v_project.status <> 'active' then
        raise exception 'project is archived';
    end if;

    -- Only the current owner can reach this path; clear the recipient's
    -- checklist overrides before promotion, including archived stages.
    for v_override in select tm.task_id,tm.role_override from public.task_members tm
      join public.tasks t on t.id=tm.task_id where t.project_id=p_project_id
      and tm.user_id=p_new_owner_id and tm.role_override is not null order by tm.task_id
    loop
      perform private.lock_task(v_override.task_id);
      update public.task_members set role_override=null,set_by=v_user,set_at=now()
        where task_id=v_override.task_id and user_id=p_new_owner_id;
      insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data,new_data)
        values(p_project_id,v_user,'role_changed','task_member',p_new_owner_id,
          jsonb_build_object('task_id',v_override.task_id,'role_override',v_override.role_override),
          jsonb_build_object('task_id',v_override.task_id,'role_override',null,'inherited_role','owner'));
    end loop;

    update public.project_members
       set role = 'admin'
     where project_id = p_project_id and user_id = v_user;
    update public.project_members
       set role = 'owner'
     where project_id = p_project_id and user_id = p_new_owner_id;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values
        (p_project_id, v_user, 'role_changed', 'project_member', v_user,
         jsonb_build_object('user_id', v_user, 'role', 'owner'),
         jsonb_build_object('user_id', v_user, 'role', 'admin')),
        (p_project_id, v_user, 'role_changed', 'project_member', p_new_owner_id,
         jsonb_build_object('user_id', p_new_owner_id, 'role', v_new_role),
         jsonb_build_object('user_id', p_new_owner_id, 'role', 'owner'));
end;
$$;

CREATE OR REPLACE FUNCTION public.create_task_from_template(p_project_id uuid, p_template_id uuid, p_title text DEFAULT NULL::text, p_description text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'private', 'public'
AS $function$
declare
    v_user uuid := private.require_auth();
    v_task_id uuid;
    v_project public.projects%rowtype;
    v_role public.project_role;
    v_template public.task_templates%rowtype;
    v_item record;
begin
    v_project := private.lock_project_state(p_project_id);
    v_role := private.lock_project_role(p_project_id, v_user);
    if v_role is null or v_role not in ('owner', 'admin') then
        raise exception 'only owner/admin can create stages from templates'
            using errcode = 'insufficient_privilege';
    end if;
    if v_project.status <> 'active' then
        raise exception 'project is archived';
    end if;

    select * into v_template
      from public.task_templates
     where id = p_template_id
       and archived_at is null
     for update;
    if not found then
        raise exception 'template not found';
    end if;

    v_task_id := public.create_task(
        p_project_id,
        coalesce(nullif(btrim(p_title), ''), v_template.name),
        case
            when p_description is null then v_template.description
            else nullif(btrim(p_description), '')
        end
    );

    insert into public.task_items(task_id,title,description,position,is_completed,percentage,comment)
    select v_task_id,i.title,i.description,row_number() over(order by i.position,i.created_at,i.id)::numeric,false,0,null
      from public.task_template_items i where i.template_id=p_template_id
      order by i.position,i.created_at,i.id;

    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, new_data)
    values (
        p_project_id,
        v_user,
        'created',
        'task_from_template',
        v_task_id,
        jsonb_build_object('task_id', v_task_id, 'template_id', p_template_id)
    );

    return v_task_id;
end;
$function$
;

-- Reuse the durable operation receipts for online mutations too. The envelope
-- operation UUID occupies the legacy target column for rpc:* receipts.
create function public.execute_client_mutation(p_operation_id uuid,p_name text,p_args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid := private.require_auth(); v_claimed boolean; v_saved jsonb; v_proc oid;
  v_arguments text; v_result jsonb;
begin
  if p_name is null or p_name <> all(array['create_project','update_project','archive_project','restore_project','hard_delete_project',
    'create_task','create_task_from_template','update_task','archive_task','restore_task','hard_delete_task','move_task',
    'create_task_item','update_task_item','archive_task_item','hard_delete_task_item','set_task_item_state','set_task_item_percentage','set_task_item_comment','set_task_item_deadline',
    'add_project_member','add_project_member_by_identifier','remove_project_member','change_member_role','transfer_project_ownership',
    'add_task_member_by_identifier','remove_task_member','set_task_member_override','clear_task_member_override','add_task_assignee','remove_task_assignee',
    'create_task_template','update_task_template','archive_task_template','create_task_template_item','update_task_template_item','delete_task_template_item','move_task_template_item',
    'update_my_profile','mark_notification_read','mark_all_notifications_read']) then raise exception 'unsupported mutation' using errcode='22023'; end if;
  if p_args is null or jsonb_typeof(p_args)<>'object' then raise exception 'invalid mutation arguments' using errcode='22023'; end if;
  select p.oid into v_proc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=p_name and p.prokind='f'
      and has_function_privilege('authenticated',p.oid,'execute')
      and not exists(select 1 from jsonb_object_keys(p_args) k where not k=any(p.proargnames))
      and not exists(select 1 from generate_series(1,p.pronargs-p.pronargdefaults) s where not p_args?p.proargnames[s])
    order by p.pronargs limit 1;
  if v_proc is null then raise exception 'invalid mutation signature' using errcode='22023'; end if;
  select claimed,saved_result into v_claimed,v_saved from private.claim_client_operation(p_operation_id,'rpc:'||p_name,p_operation_id,p_args);
  if not v_claimed then return v_saved->'value'; end if;
  select string_agg(format('%I => ($1->>%L)::%s',p.proargnames[s],p.proargnames[s],format_type(p.proargtypes[s-1],null)),',' order by s)
    into v_arguments from pg_proc p cross join generate_series(1,p.pronargs) s where p.oid=v_proc and p_args?p.proargnames[s];
  execute format('select to_jsonb(public.%I(%s))',p_name,coalesce(v_arguments,'')) into v_result using p_args;
  update private.client_operation_receipts set result_payload=jsonb_build_object('value',v_result),completed_at=clock_timestamp()
    where user_id=v_user and operation_id=p_operation_id;
  return v_result;
end $$;
revoke all on function public.execute_client_mutation(uuid,text,jsonb) from public,anon,service_role;
grant execute on function public.execute_client_mutation(uuid,text,jsonb) to authenticated;

notify pgrst,'reload schema';
commit;
