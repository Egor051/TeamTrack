-- Reconciliation for the hosted task enhancements schema.
-- This migration is forward-only and idempotent: existing hosted objects are
-- reused, while stale local definitions are brought to the canonical shape.

alter table public.task_items add column if not exists percentage integer not null default 0;
alter table public.task_items add column if not exists comment text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.task_items'::regclass and conname='task_items_completion_percent_chk') then
    alter table public.task_items add constraint task_items_completion_percent_chk check (percentage between 0 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.task_items'::regclass and conname='task_items_comment_length_chk') then
    alter table public.task_items add constraint task_items_comment_length_chk check (comment is null or char_length(comment) <= 2000);
  end if;
end $$;

create or replace function private.sync_task_item_completion()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if tg_op = 'INSERT' then
    new.is_completed := new.percentage = 100;
  elsif new.percentage is distinct from old.percentage then
    new.is_completed := new.percentage = 100;
  elsif new.is_completed is distinct from old.is_completed then
    new.percentage := case when new.is_completed then 100 else 0 end;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_sync_task_item_completion on public.task_items;
drop trigger if exists trg_task_items_sync_completion on public.task_items;
create trigger trg_sync_task_item_completion
before insert or update of percentage, is_completed on public.task_items
for each row execute function private.sync_task_item_completion();
revoke all on function private.sync_task_item_completion() from public, anon, authenticated;

create or replace function private.task_status_from_items(p_task_id uuid)
returns public.task_status language sql stable security definer
set search_path = private, public as $$
  select case
    when count(*) = 0 or coalesce(avg(ti.percentage), 0) = 0 then 'not_started'::public.task_status
    when avg(ti.percentage) = 100 then 'completed'::public.task_status
    else 'in_progress'::public.task_status
  end
  from public.task_items ti
  where ti.task_id = p_task_id and not ti.is_archived;
$$;

create or replace function private.recalculate_task_status_trigger()
returns trigger language plpgsql security definer
set search_path = private, public as $$
declare v_task_id uuid := coalesce(new.task_id, old.task_id);
begin
  perform private.recalculate_task_status(v_task_id);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists trg_task_items_recalculate_status on public.task_items;
create trigger trg_task_items_recalculate_status
after insert or delete or update of percentage, is_archived on public.task_items
for each row execute function private.recalculate_task_status_trigger();

create table if not exists public.task_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create table if not exists public.task_template_items (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.task_templates(id) on delete cascade,
  title text not null,
  description text,
  position numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.task_templates'::regclass and conname='task_templates_name_chk') then
    alter table public.task_templates add constraint task_templates_name_chk check (char_length(btrim(name)) between 1 and 200);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.task_templates'::regclass and conname='task_templates_description_chk') then
    alter table public.task_templates add constraint task_templates_description_chk check (description is null or char_length(description) <= 10000);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.task_template_items'::regclass and conname='task_template_items_title_chk') then
    alter table public.task_template_items add constraint task_template_items_title_chk check (char_length(btrim(title)) between 1 and 500);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.task_template_items'::regclass and conname='task_template_items_description_chk') then
    alter table public.task_template_items add constraint task_template_items_description_chk check (description is null or char_length(description) <= 10000);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.task_template_items'::regclass and conname='task_template_items_position_chk') then
    alter table public.task_template_items add constraint task_template_items_position_chk check (position >= 0 and position <> 'NaN'::numeric);
  end if;
end $$;
create index if not exists idx_task_templates_created_at on public.task_templates(created_at desc);
create index if not exists idx_task_template_items_template_position on public.task_template_items(template_id, position, created_at);

create or replace function private.touch_task_template_updated_at()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists trg_task_templates_updated_at on public.task_templates;
create trigger trg_task_templates_updated_at before update on public.task_templates for each row execute function private.touch_task_template_updated_at();
drop trigger if exists trg_task_template_items_updated_at on public.task_template_items;
create trigger trg_task_template_items_updated_at before update on public.task_template_items for each row execute function private.touch_task_template_updated_at();

alter table public.task_templates enable row level security;
alter table public.task_template_items enable row level security;
revoke all on public.task_templates, public.task_template_items from anon, authenticated;
grant select, insert, update, delete on public.task_templates, public.task_template_items to service_role;

create or replace function public.update_task(p_task_id uuid, p_title text default null, p_description text default null)
returns void language plpgsql security definer set search_path = private, public as $$
declare v_user uuid := private.require_auth(); r public.tasks%rowtype; v_title text; v_description text;
begin
  select * into r from public.tasks where id=p_task_id for update;
  if not found or not private.can_edit_task(p_task_id) then raise exception 'no access to task' using errcode='insufficient_privilege'; end if;
  if r.status='archived' or not private.project_is_active(r.project_id) then raise exception 'task is archived'; end if;
  v_title := case when p_title is null then r.title else btrim(p_title) end;
  v_description := case when p_description is null then r.description else nullif(btrim(p_description), '') end;
  if char_length(v_title) < 1 or char_length(v_title) > 500 then raise exception 'task title must contain 1..500 characters'; end if;
  if v_description is not null and char_length(v_description) > 10000 then raise exception 'task description is too long'; end if;
  if v_title is not distinct from r.title and v_description is not distinct from r.description then return; end if;
  update public.tasks set title=v_title, description=v_description where id=r.id;
  insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data,new_data)
  values(r.project_id,v_user,'updated','task',r.id,jsonb_build_object('title',r.title,'description',r.description),jsonb_build_object('title',v_title,'description',v_description));
end;
$$;

create or replace function public.set_task_item_comment(p_task_item_id uuid, p_comment text)
returns void language plpgsql security definer set search_path = private, public as $$
declare v_user uuid := private.require_auth(); r public.task_items%rowtype; t public.tasks%rowtype; v_project_id uuid; v_comment text := nullif(btrim(coalesce(p_comment,'')), '');
begin
  if p_comment is not null and char_length(p_comment) > 2000 then raise exception 'item comment is too long'; end if;
  select * into r from public.task_items where id=p_task_item_id for update;
  if not found or not private.can_edit_task(r.task_id) then raise exception 'no access to task item' using errcode='insufficient_privilege'; end if;
  select * into t from public.tasks where id=r.task_id;
  if r.is_archived or t.status='archived' or not private.project_is_active(t.project_id) then raise exception 'task item is archived'; end if;
  if r.comment is not distinct from v_comment then return; end if;
  update public.task_items set comment=v_comment where id=r.id;
  v_project_id := t.project_id;
  insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data,new_data)
  values(v_project_id,v_user,'updated','task_item',r.id,jsonb_build_object('comment',r.comment),jsonb_build_object('comment',v_comment));
end;
$$;

create or replace function public.set_task_item_percentage(p_task_item_id uuid, p_percentage integer)
returns integer language plpgsql security definer set search_path = private, public as $$
declare v_user uuid := private.require_auth(); r public.task_items%rowtype; t public.tasks%rowtype; v_project_id uuid;
begin
  if p_percentage is null or p_percentage not between 0 and 100 then raise exception 'percentage must be between 0 and 100'; end if;
  select * into r from public.task_items where id=p_task_item_id for update;
  if not found or not private.can_edit_task(r.task_id) then raise exception 'no access to task item' using errcode='insufficient_privilege'; end if;
  select * into t from public.tasks where id=r.task_id;
  if r.is_archived or t.status='archived' or not private.project_is_active(t.project_id) then raise exception 'task item is archived'; end if;
  if r.percentage = p_percentage then return p_percentage; end if;
  update public.task_items set percentage=p_percentage where id=r.id;
  v_project_id := t.project_id;
  insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data,new_data)
  values(v_project_id,v_user,'updated','task_item',r.id,jsonb_build_object('percentage',r.percentage,'is_completed',r.is_completed),jsonb_build_object('percentage',p_percentage,'is_completed',p_percentage=100));
  return p_percentage;
end;
$$;

create or replace function public.set_task_item_progress(p_task_item_id uuid, p_completion_percent integer)
returns integer language sql security definer set search_path = private, public as $$ select public.set_task_item_percentage(p_task_item_id, p_completion_percent); $$;

create or replace function public.set_task_item_state(p_task_item_id uuid, p_completed boolean)
returns boolean language plpgsql security definer set search_path = private, public as $$
declare v_user uuid:=private.require_auth(); r public.task_items%rowtype; t public.tasks%rowtype; v_project_id uuid; v_percentage integer:=case when p_completed then 100 else 0 end;
begin
  select * into r from public.task_items where id=p_task_item_id for update;
  if not found or not private.can_edit_task(r.task_id) then raise exception 'no access to task item' using errcode='insufficient_privilege'; end if;
  select * into t from public.tasks where id=r.task_id;
  if r.is_archived or t.status='archived' or not private.project_is_active(t.project_id) then raise exception 'task item is archived'; end if;
  if r.percentage = v_percentage then return p_completed; end if;
  update public.task_items set percentage=v_percentage where id=r.id;
  v_project_id := t.project_id;
  insert into public.item_actions(project_id,task_id,task_item_id,user_id,action) values(v_project_id,r.task_id,r.id,v_user,case when p_completed then 'checked'::public.item_action_type else 'unchecked'::public.item_action_type end);
  insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,old_data,new_data) values(v_project_id,v_user,case when p_completed then 'checked'::public.audit_action else 'unchecked'::public.audit_action end,'task_item',r.id,jsonb_build_object('is_completed',r.is_completed),jsonb_build_object('is_completed',p_completed));
  return p_completed;
end;
$$;

create or replace function public.list_task_templates()
returns table(id uuid,name text,description text,created_by uuid,created_at timestamptz,updated_at timestamptz,item_count bigint)
language sql stable security definer set search_path = private, public as $$
  select t.id,t.name,t.description,t.created_by,t.created_at,t.updated_at,(select count(*) from public.task_template_items i where i.template_id=t.id)
  from public.task_templates t where t.archived_at is null order by t.created_at desc;
$$;
create or replace function public.list_task_template_items(p_template_id uuid)
returns table(id uuid,template_id uuid,title text,description text,template_position numeric,created_at timestamptz,updated_at timestamptz)
language sql stable security definer set search_path = private, public as $$
  select i.id,i.template_id,i.title,i.description,i.position,i.created_at,i.updated_at from public.task_template_items i join public.task_templates t on t.id=i.template_id where i.template_id=p_template_id and t.archived_at is null order by i.position,i.created_at;
$$;
create or replace function public.get_task_template(p_template_id uuid)
returns jsonb language sql stable security definer set search_path = private, public as $$
  select jsonb_build_object('id',t.id,'name',t.name,'description',t.description,'created_by',t.created_by,'created_at',t.created_at,'updated_at',t.updated_at,'items',coalesce((select jsonb_agg(to_jsonb(i) order by i.position,i.created_at) from public.task_template_items i where i.template_id=t.id),'[]'::jsonb))
  from public.task_templates t where t.id=p_template_id and t.archived_at is null;
$$;

create or replace function public.create_task_template(p_name text,p_description text default null)
returns uuid language plpgsql security definer set search_path = private, public as $$
declare v_user uuid:=private.require_auth(); v_id uuid;
begin
  if p_name is null or char_length(btrim(p_name)) not between 1 and 200 then raise exception 'template name must contain 1..200 characters'; end if;
  if p_description is not null and char_length(p_description)>10000 then raise exception 'template description is too long'; end if;
  insert into public.task_templates(name,description,created_by) values(btrim(p_name),nullif(btrim(p_description),''),v_user) returning id into v_id;
  insert into public.audit_log(user_id,action,entity_type,entity_id,new_data) values(v_user,'created','task_template',v_id,jsonb_build_object('name',btrim(p_name),'description',p_description));
  return v_id;
end;
$$;
create or replace function public.update_task_template(p_template_id uuid,p_name text default null,p_description text default null)
returns void language plpgsql security definer set search_path = private, public as $$
declare v_user uuid:=private.require_auth(); r public.task_templates%rowtype;
begin
  select * into r from public.task_templates where id=p_template_id for update;
  if not found or r.archived_at is not null then raise exception 'template not found'; end if;
  if r.created_by<>v_user then raise exception 'only template creator can edit it' using errcode='insufficient_privilege'; end if;
  if p_name is not null and char_length(btrim(p_name)) not between 1 and 200 then raise exception 'template name must contain 1..200 characters'; end if;
  if p_description is not null and char_length(p_description)>10000 then raise exception 'template description is too long'; end if;
  update public.task_templates set name=coalesce(btrim(p_name),name),description=case when p_description is null then description else nullif(btrim(p_description),'') end,updated_at=now() where id=r.id;
  insert into public.audit_log(user_id,action,entity_type,entity_id,old_data,new_data) values(v_user,'updated','task_template',r.id,jsonb_build_object('name',r.name,'description',r.description),jsonb_build_object('name',coalesce(btrim(p_name),r.name),'description',case when p_description is null then r.description else nullif(btrim(p_description),'') end));
end;
$$;
create or replace function public.archive_task_template(p_template_id uuid)
returns void language plpgsql security definer set search_path = private, public as $$
declare v_user uuid:=private.require_auth(); r public.task_templates%rowtype;
begin
  select * into r from public.task_templates where id=p_template_id for update;
  if not found or r.archived_at is not null then raise exception 'template not found'; end if;
  if r.created_by<>v_user then raise exception 'only template creator can archive it' using errcode='insufficient_privilege'; end if;
  update public.task_templates set archived_at=now(),updated_at=now() where id=r.id;
  insert into public.audit_log(user_id,action,entity_type,entity_id,old_data,new_data) values(v_user,'archived','task_template',r.id,jsonb_build_object('archived_at',null),jsonb_build_object('archived_at',now()));
end;
$$;
create or replace function public.create_task_template_item(p_template_id uuid,p_title text,p_description text default null,p_position numeric default null)
returns uuid language plpgsql security definer set search_path = private, public as $$
declare v_user uuid:=private.require_auth(); r public.task_templates%rowtype; v_id uuid; v_pos numeric;
begin
  select * into r from public.task_templates where id=p_template_id for update;
  if not found or r.archived_at is not null then raise exception 'template not found'; end if;
  if r.created_by<>v_user then raise exception 'only template creator can edit it' using errcode='insufficient_privilege'; end if;
  if p_title is null or char_length(btrim(p_title)) not between 1 and 500 then raise exception 'template item title must contain 1..500 characters'; end if;
  select coalesce(p_position,coalesce(max(position),0)+1) into v_pos from public.task_template_items where template_id=p_template_id;
  insert into public.task_template_items(template_id,title,description,position) values(p_template_id,btrim(p_title),nullif(btrim(p_description),''),v_pos) returning id into v_id;
  return v_id;
end;
$$;
create or replace function public.update_task_template_item(p_item_id uuid,p_title text default null,p_description text default null,p_position numeric default null)
returns void language plpgsql security definer set search_path = private, public as $$
declare v_user uuid:=private.require_auth(); r public.task_template_items%rowtype; t public.task_templates%rowtype;
begin
  select * into r from public.task_template_items where id=p_item_id for update; if not found then raise exception 'template item not found'; end if;
  select * into t from public.task_templates where id=r.template_id for update; if t.archived_at is not null or t.created_by<>v_user then raise exception 'no permission to edit template item' using errcode='insufficient_privilege'; end if;
  if p_title is not null and char_length(btrim(p_title)) not between 1 and 500 then raise exception 'template item title must contain 1..500 characters'; end if;
  update public.task_template_items set title=coalesce(btrim(p_title),title),description=case when p_description is null then description else nullif(btrim(p_description),'') end,position=coalesce(p_position,position),updated_at=now() where id=r.id;
end;
$$;
create or replace function public.remove_task_template_item(p_item_id uuid)
returns void language plpgsql security definer set search_path = private, public as $$
declare v_user uuid:=private.require_auth(); r public.task_template_items%rowtype; t public.task_templates%rowtype;
begin
  select * into r from public.task_template_items where id=p_item_id for update; if not found then raise exception 'template item not found'; end if;
  select * into t from public.task_templates where id=r.template_id for update; if t.archived_at is not null or t.created_by<>v_user then raise exception 'no permission to remove template item' using errcode='insufficient_privilege'; end if;
  delete from public.task_template_items where id=r.id;
end;
$$;
create or replace function public.delete_task_template_item(p_item_id uuid)
returns void language sql security definer set search_path = private, public as $$ select public.remove_task_template_item(p_item_id); $$;
create or replace function public.create_task_from_template(p_project_id uuid,p_template_id uuid,p_title text default null,p_description text default null)
returns uuid language plpgsql security definer set search_path = private, public as $$
declare v_user uuid:=private.require_auth(); v_task_id uuid; t public.task_templates%rowtype; i record;
begin
  select * into t from public.task_templates where id=p_template_id and archived_at is null for update; if not found then raise exception 'template not found'; end if;
  if not private.is_project_member(p_project_id) or private.project_role_of(p_project_id)='viewer' then raise exception 'viewers cannot create tasks' using errcode='insufficient_privilege'; end if;
  v_task_id:=public.create_task(p_project_id,coalesce(nullif(btrim(p_title),''),t.name),case when p_description is null then t.description else nullif(btrim(p_description),'') end);
  for i in select title,description,position from public.task_template_items where template_id=t.id order by position,created_at loop
    insert into public.task_items(task_id,title,description,position,percentage,is_completed) values(v_task_id,i.title,i.description,i.position,0,false);
  end loop;
  insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,new_data) values(p_project_id,v_user,'created','task_from_template',v_task_id,jsonb_build_object('template_id',t.id));
  return v_task_id;
end;
$$;

revoke all on function public.update_task(uuid,text,text),public.set_task_item_comment(uuid,text),public.set_task_item_percentage(uuid,integer),public.set_task_item_progress(uuid,integer),public.set_task_item_state(uuid,boolean),public.list_task_templates(),public.list_task_template_items(uuid),public.get_task_template(uuid),public.create_task_template(text,text),public.update_task_template(uuid,text,text),public.archive_task_template(uuid),public.create_task_template_item(uuid,text,text,numeric),public.update_task_template_item(uuid,text,text,numeric),public.remove_task_template_item(uuid),public.delete_task_template_item(uuid),public.create_task_from_template(uuid,uuid,text,text) from public,anon;
grant execute on function public.update_task(uuid,text,text),public.set_task_item_comment(uuid,text),public.set_task_item_percentage(uuid,integer),public.set_task_item_progress(uuid,integer),public.set_task_item_state(uuid,boolean),public.list_task_templates(),public.list_task_template_items(uuid),public.get_task_template(uuid),public.create_task_template(text,text),public.update_task_template(uuid,text,text),public.archive_task_template(uuid),public.create_task_template_item(uuid,text,text,numeric),public.update_task_template_item(uuid,text,text,numeric),public.remove_task_template_item(uuid),public.delete_task_template_item(uuid),public.create_task_from_template(uuid,uuid,text,text) to authenticated,service_role;
