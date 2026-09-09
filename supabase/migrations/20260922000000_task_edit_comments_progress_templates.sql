-- Task editing, checklist comments/progress, and global task templates.
-- This migration is additive and keeps the existing RPC-first security model.

-- -----------------------------------------------------------------------------
-- Checklist progress is the source of truth; is_completed remains a compatibility
-- projection for existing clients and history consumers.
-- -----------------------------------------------------------------------------

alter table public.task_items
    add column if not exists percentage integer not null default 0,
    add column if not exists comment text;

update public.task_items
set percentage = case when is_completed then 100 else 0 end
where percentage = 0 and is_completed;

alter table public.task_items
    add constraint task_items_percentage_range
    check (percentage between 0 and 100),
    add constraint task_items_comment_length
    check (comment is null or length(comment) <= 2000);

create or replace function private.sync_task_item_completion()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
    if tg_op = 'INSERT' or new.percentage is distinct from old.percentage then
        new.is_completed := new.percentage = 100;
    elsif new.is_completed is distinct from old.is_completed then
        -- Compatibility for trusted server-side legacy writes.
        new.percentage := case when new.is_completed then 100 else 0 end;
    end if;
    return new;
end;
$$;

drop trigger if exists trg_task_items_sync_completion on public.task_items;
create trigger trg_task_items_sync_completion
before insert or update on public.task_items
for each row execute function private.sync_task_item_completion();
revoke all on function private.sync_task_item_completion() from public, anon, authenticated;

-- The existing status helper historically counted boolean completion. Extend it
-- so task status follows the percentage source of truth as well.
create or replace function private.task_status_from_items(p_task_id uuid)
returns public.task_status
language sql stable security definer
set search_path = private, public
as $$
    select case
        when count(*) = 0 or count(*) filter (where ti.percentage = 0) = count(*) then 'not_started'::public.task_status
        when count(*) filter (where ti.percentage = 100) = count(*) then 'completed'::public.task_status
        else 'in_progress'::public.task_status
    end
    from public.task_items ti
    where ti.task_id = p_task_id and not ti.is_archived
$$;

drop trigger if exists trg_task_items_recalculate_status on public.task_items;
create trigger trg_task_items_recalculate_status
after insert or update of percentage, is_completed, is_archived on public.task_items
for each row execute function private.recalculate_task_status_trigger();

-- item_actions remains the legacy binary action stream; percentage changes are
-- fully recorded in audit_log (including old/new percentage) so no conflicting
-- second history mechanism is introduced.

-- -----------------------------------------------------------------------------
-- Global templates
-- -----------------------------------------------------------------------------

create table if not exists public.task_templates (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    description text,
    created_by uuid not null references auth.users(id) on delete restrict,
    status public.project_status not null default 'active',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    archived_at timestamptz,
    constraint task_templates_name_not_blank check (length(btrim(name)) > 0),
    constraint task_templates_archive_consistency check (
        (status = 'archived' and archived_at is not null)
        or (status = 'active' and archived_at is null)
    )
);

create table if not exists public.task_template_items (
    id uuid primary key default gen_random_uuid(),
    template_id uuid not null references public.task_templates(id) on delete cascade,
    title text not null,
    description text,
    position integer not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint task_template_items_title_not_blank check (length(btrim(title)) > 0),
    constraint task_template_items_position_positive check (position > 0),
    constraint task_template_items_position_unique unique (template_id, position)
);

create index if not exists idx_task_templates_status_updated
    on public.task_templates(status, updated_at desc);
create index if not exists idx_task_templates_created_by
    on public.task_templates(created_by);
create index if not exists idx_task_template_items_template_position
    on public.task_template_items(template_id, position);

create trigger trg_task_templates_updated_at
before update on public.task_templates
for each row execute function public.set_updated_at();
create trigger trg_task_template_items_updated_at
before update on public.task_template_items
for each row execute function public.set_updated_at();

alter table public.task_templates enable row level security;
alter table public.task_template_items enable row level security;

create or replace function private.is_template_admin(p_user_id uuid default auth.uid())
returns boolean
language sql stable security definer
set search_path = private, public
as $$
    select exists (
        select 1 from public.project_members
        where user_id = p_user_id and role in ('owner', 'admin')
    );
$$;

create policy task_templates_select_authenticated
on public.task_templates for select to authenticated
using (status = 'active');

create policy task_template_items_select_authenticated
on public.task_template_items for select to authenticated
using (exists (
    select 1 from public.task_templates t
    where t.id = template_id and t.status = 'active'
));

grant select on public.task_templates, public.task_template_items to authenticated;
revoke insert, update, delete, truncate on public.task_templates, public.task_template_items from authenticated;
grant usage on schema private to authenticated;
revoke all on function private.is_template_admin(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Task editing and checklist mutations
-- -----------------------------------------------------------------------------

create or replace function public.update_task(
    p_task_id uuid,
    p_title text,
    p_description text
)
returns void
language plpgsql security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    r public.tasks%rowtype;
begin
    select * into r from public.tasks where id = p_task_id for update;
    if not found or not private.can_edit_task(p_task_id) then
        raise exception 'no access to task' using errcode = 'insufficient_privilege';
    end if;
    if not private.task_is_editable(p_task_id) then
        raise exception 'task is archived';
    end if;
    if p_title is null or length(btrim(p_title)) = 0 then
        raise exception 'task title must not be blank';
    end if;
    update public.tasks
       set title = p_title, description = nullif(btrim(coalesce(p_description, '')), '')
     where id = p_task_id;
    -- The existing task update trigger writes the complete field diff to audit_log.
end
$$;

revoke update on public.tasks from authenticated;

create or replace function public.set_task_item_comment(
    p_task_item_id uuid,
    p_comment text
)
returns void
language plpgsql security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    r public.task_items%rowtype;
    v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
    v_project_id uuid;
begin
    select * into r from public.task_items where id = p_task_item_id for update;
    if not found or not private.can_edit_task(r.task_id) then
        raise exception 'no access to task item' using errcode = 'insufficient_privilege';
    end if;
    if not private.task_is_editable(r.task_id) or r.is_archived then
        raise exception 'task item is archived';
    end if;
    if v_comment is not null and length(v_comment) > 2000 then
        raise exception 'task item comment is too long';
    end if;
    if r.comment is not distinct from v_comment then return; end if;
    update public.task_items set comment = v_comment where id = r.id;
    select project_id into v_project_id from public.tasks where id = r.task_id;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_project_id, v_user, 'updated', 'task_item', r.id,
        jsonb_build_object('comment', r.comment),
        jsonb_build_object('comment', v_comment)
    );
end
$$;

create or replace function public.set_task_item_percentage(
    p_task_item_id uuid,
    p_percentage integer
)
returns integer
language plpgsql security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    r_item public.task_items%rowtype;
    r_task public.tasks%rowtype;
    v_action public.item_action_type;
begin
    if p_percentage is null or p_percentage < 0 or p_percentage > 100 then
        raise exception 'percentage must be between 0 and 100';
    end if;
    select * into r_item from public.task_items where id = p_task_item_id for update;
    if not found or not private.can_edit_task(r_item.task_id) then
        raise exception 'no access to task item' using errcode = 'insufficient_privilege';
    end if;
    select * into r_task from public.tasks where id = r_item.task_id;
    if not private.task_is_editable(r_item.task_id) or r_item.is_archived then
        raise exception 'task item is archived';
    end if;
    if r_item.percentage = p_percentage then return p_percentage; end if;
    update public.task_items set percentage = p_percentage where id = r_item.id;
    v_action := case when p_percentage = 100 then 'checked'::public.item_action_type else 'unchecked'::public.item_action_type end;
    insert into public.item_actions(project_id, task_id, task_item_id, user_id, action)
    values (r_task.project_id, r_task.id, r_item.id, v_user, v_action);
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        r_task.project_id, v_user, 'updated', 'task_item', r_item.id,
        jsonb_build_object('percentage', r_item.percentage, 'is_completed', r_item.is_completed),
        jsonb_build_object('percentage', p_percentage, 'is_completed', p_percentage = 100)
    );
    return p_percentage;
end
$$;

-- Keep the legacy checkbox RPC and its audit shape, while making percentage the
-- single source of truth underneath.
create or replace function public.set_task_item_state(
    p_task_item_id uuid,
    p_completed boolean
)
returns boolean
language plpgsql security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    r_item public.task_items%rowtype;
    r_task public.tasks%rowtype;
    v_action public.item_action_type;
begin
    select * into r_item from public.task_items where id = p_task_item_id for update;
    if not found or not private.can_edit_task(r_item.task_id) then
        raise exception 'no access to task item' using errcode = 'insufficient_privilege';
    end if;
    select * into r_task from public.tasks where id = r_item.task_id;
    if not private.task_is_editable(r_item.task_id) or r_item.is_archived then
        raise exception 'task item is archived';
    end if;
    if r_item.is_completed = p_completed then return p_completed; end if;
    update public.task_items set percentage = case when p_completed then 100 else 0 end where id = r_item.id;
    v_action := case when p_completed then 'checked' else 'unchecked' end;
    insert into public.item_actions(project_id, task_id, task_item_id, user_id, action)
    values (r_task.project_id, r_task.id, r_item.id, v_user, v_action);
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (r_task.project_id, v_user, v_action::text::public.audit_action, 'task_item', r_item.id,
            jsonb_build_object('is_completed', r_item.is_completed),
            jsonb_build_object('is_completed', p_completed));
    return p_completed;
end
$$;

-- -----------------------------------------------------------------------------
-- Template RPCs
-- -----------------------------------------------------------------------------

create function public.create_task_template(p_name text, p_description text default null)
returns uuid language plpgsql security definer set search_path = private, public
as $$
declare v_user uuid := private.require_auth(); v_id uuid;
begin
    if not private.is_template_admin(v_user) then raise exception 'only owner/admin can manage templates' using errcode='insufficient_privilege'; end if;
    if p_name is null or length(btrim(p_name)) = 0 then raise exception 'template name must not be blank'; end if;
    insert into public.task_templates(name, description, created_by) values (btrim(p_name), nullif(btrim(coalesce(p_description,'')),''), v_user) returning id into v_id;
    return v_id;
end $$;

create function public.update_task_template(p_template_id uuid, p_name text, p_description text default null)
returns void language plpgsql security definer set search_path = private, public
as $$
begin
    if not private.is_template_admin() then raise exception 'only owner/admin can manage templates' using errcode='insufficient_privilege'; end if;
    if p_name is null or length(btrim(p_name)) = 0 then raise exception 'template name must not be blank'; end if;
    update public.task_templates set name=btrim(p_name), description=nullif(btrim(coalesce(p_description,'')), '') where id=p_template_id and status='active';
    if not found then raise exception 'template not found'; end if;
end $$;

create function public.archive_task_template(p_template_id uuid)
returns void language plpgsql security definer set search_path = private, public
as $$
begin
    if not private.is_template_admin() then raise exception 'only owner/admin can manage templates' using errcode='insufficient_privilege'; end if;
    update public.task_templates set status='archived', archived_at=now() where id=p_template_id and status='active';
end $$;

create function public.create_task_template_item(p_template_id uuid, p_title text, p_description text default null, p_position integer default null)
returns uuid language plpgsql security definer set search_path = private, public
as $$
declare v_id uuid; v_pos integer;
begin
    if not private.is_template_admin() then raise exception 'only owner/admin can manage templates' using errcode='insufficient_privilege'; end if;
    if p_title is null or length(btrim(p_title))=0 then raise exception 'template item title must not be blank'; end if;
    if not exists(select 1 from public.task_templates where id=p_template_id and status='active') then raise exception 'template not found'; end if;
    select coalesce(max(position),0)+1 into v_pos from public.task_template_items where template_id=p_template_id;
    v_pos := least(greatest(coalesce(p_position, v_pos), 1), v_pos);
    update public.task_template_items set position=position+1000000 where template_id=p_template_id and position >= v_pos;
    update public.task_template_items set position=position-999999 where template_id=p_template_id and position >= v_pos + 1000000;
    insert into public.task_template_items(template_id,title,description,position) values(p_template_id,btrim(p_title),nullif(btrim(coalesce(p_description,'')),''),v_pos) returning id into v_id;
    return v_id;
end $$;

create function public.update_task_template_item(p_item_id uuid, p_title text, p_description text default null, p_position integer default null)
returns void language plpgsql security definer set search_path = private, public
as $$
declare v_template uuid; v_old integer; v_new integer; v_max integer;
begin
    if not private.is_template_admin() then raise exception 'only owner/admin can manage templates' using errcode='insufficient_privilege'; end if;
    select template_id, position into v_template, v_old from public.task_template_items where id=p_item_id;
    if v_template is null or not exists(select 1 from public.task_templates where id=v_template and status='active') then raise exception 'template item not found'; end if;
    if p_title is null or length(btrim(p_title))=0 then raise exception 'template item title must not be blank'; end if;
    v_new := coalesce(p_position, v_old);
    if v_new < 1 then raise exception 'template item position must be positive'; end if;
    select coalesce(max(position), v_old) into v_max from public.task_template_items where template_id=v_template;
    v_new := least(v_new, v_max);
    if v_new <> v_old then
      update public.task_template_items set position = v_max + 1 where id = p_item_id;
      if v_new < v_old then
        update public.task_template_items set position = position + 1 where template_id=v_template and id<>p_item_id and position >= v_new and position < v_old;
      else
        update public.task_template_items set position = position - 1 where template_id=v_template and id<>p_item_id and position > v_old and position <= v_new;
      end if;
    end if;
    update public.task_template_items set title=btrim(p_title), description=nullif(btrim(coalesce(p_description,'')),''), position=v_new where id=p_item_id;
end $$;

create function public.delete_task_template_item(p_item_id uuid)
returns void language plpgsql security definer set search_path = private, public
as $$
declare v_template uuid; v_position integer;
begin
    if not private.is_template_admin() then raise exception 'only owner/admin can manage templates' using errcode='insufficient_privilege'; end if;
    select template_id, position into v_template, v_position from public.task_template_items where id=p_item_id;
    if v_template is null then raise exception 'template item not found'; end if;
    delete from public.task_template_items where id=p_item_id;
    update public.task_template_items set position=position-1 where template_id=v_template and position > v_position;
end $$;

create or replace function public.create_task_from_template(p_project_id uuid, p_template_id uuid, p_title text default null, p_description text default null)
returns uuid language plpgsql security definer set search_path = private, public
as $$
declare v_user uuid := private.require_auth(); v_task uuid; v_template public.task_templates%rowtype; v_title text; v_description text;
begin
    if not private.is_project_member(p_project_id) or private.project_role_of(p_project_id)='viewer' then raise exception 'viewers cannot create tasks' using errcode='insufficient_privilege'; end if;
    if not private.project_is_active(p_project_id) then raise exception 'project is archived'; end if;
    select * into v_template from public.task_templates where id=p_template_id and status='active';
    if not found then raise exception 'template not found'; end if;
    v_title := coalesce(nullif(btrim(p_title), ''), v_template.name);
    v_description := nullif(btrim(coalesce(p_description, v_template.description, '')), '');
    insert into public.tasks(project_id,title,description,created_by) values(p_project_id,v_title,v_description,v_user) returning id into v_task;
    insert into public.task_members(task_id,user_id,approved_by) values(v_task,v_user,v_user);
    insert into public.task_items(task_id,title,description,position,percentage,comment)
    select v_task, title, description, position, 0, null from public.task_template_items where template_id=v_template.id order by position;
    insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,new_data) values(p_project_id,v_user,'created','task',v_task,jsonb_build_object('title',v_title,'description',v_description,'template_id',v_template.id));
    return v_task;
end $$;

do $$
begin
    execute 'revoke all on all functions in schema public from public, anon';
    execute 'grant execute on function public.update_task(uuid,text,text), public.set_task_item_comment(uuid,text), public.set_task_item_percentage(uuid,integer), public.set_task_item_state(uuid,boolean), public.create_task_template(text,text), public.update_task_template(uuid,text,text), public.archive_task_template(uuid), public.create_task_template_item(uuid,text,text,integer), public.update_task_template_item(uuid,text,text,integer), public.delete_task_template_item(uuid), public.create_task_from_template(uuid,uuid,text,text) to authenticated, service_role';
end $$;
