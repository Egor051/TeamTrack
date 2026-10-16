-- One ordering contract for fresh Git installs and the audited hosted schema.
-- The parent lock serializes append, reorder, text edit, delete and copy.
-- No rows are reordered/rewritten by this migration. Hosted already has the
-- strict UNIQUE; fresh installs replace the formerly deferrable constraint.
begin;
set local lock_timeout = '3s';

alter function private.sync_task_item_completion() set search_path=pg_catalog,public;
alter function private.touch_task_template_updated_at() set search_path=pg_catalog,public;
drop trigger trg_task_items_recalculate_status on public.task_items;
create trigger trg_task_items_recalculate_status
 after insert or delete or update of percentage,is_completed,is_archived on public.task_items
 for each row execute function private.recalculate_task_status_trigger();

do $migration$
begin
  if exists(select 1 from pg_constraint where conrelid='public.task_template_items'::regclass
      and conname='task_template_items_template_position_key' and condeferrable) then
    alter table public.task_template_items drop constraint task_template_items_template_position_key;
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.task_template_items'::regclass
      and conname='task_template_items_template_position_key') then
    alter table public.task_template_items add constraint task_template_items_template_position_key
      unique(template_id,position);
  end if;
end $migration$;

-- Canonical equivalent expressions; NOT VALID preserves any historical
-- invalid profile names until the validation block below can certify them.
alter table public.profiles drop constraint profiles_display_name_valid;
alter table public.profiles add constraint profiles_display_name_valid check(
 char_length(btrim(display_name)) between 2 and 80 and btrim(display_name) ~ '^[[:alnum:]_ .-]+$'
) not valid;
alter table public.task_template_items drop constraint task_template_items_position_chk;
alter table public.task_template_items add constraint task_template_items_position_chk check(
 position>=0 and position not in ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric)
);

-- These indexes existed on only one lineage. Keep the union: no DROP INDEX
-- and no loss of FK maintenance or the active-template listing access path.
create index if not exists idx_item_actions_item_task on public.item_actions(task_item_id,task_id);
create index if not exists idx_item_actions_task_project on public.item_actions(task_id,project_id);
create index if not exists idx_task_assignees_assigned_by on public.task_assignees(assigned_by);
create index if not exists idx_task_members_approved_by on public.task_members(set_by);
create index if not exists task_template_items_template_position_idx on public.task_template_items(template_id,position);
create index if not exists task_templates_active_idx on public.task_templates(created_at desc) where archived_at is null;

-- A redundant hosted-only percent check is safe to remove only after proving
-- the authoritative, validated equivalent is present. The range stays enforced.
do $migration$
begin
  if exists(select 1 from pg_constraint where conrelid='public.task_items'::regclass
      and conname='task_items_completion_percent_chk') then
    if not exists(select 1 from pg_constraint where conrelid='public.task_items'::regclass
        and conname='task_items_percentage_range' and convalidated) then
      raise exception 'validated canonical percentage constraint is required';
    end if;
    alter table public.task_items drop constraint task_items_completion_percent_chk;
  end if;
end $migration$;

CREATE OR REPLACE FUNCTION public.create_task_template_item(p_template_id uuid, p_title text, p_description text DEFAULT NULL::text, p_position numeric DEFAULT NULL::numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'private', 'public'
AS $function$
declare
    v_user uuid := private.require_auth();
    v_template public.task_templates%rowtype;
    v_title text := btrim(coalesce(p_title, ''));
    v_description text := nullif(btrim(coalesce(p_description, '')), '');
    v_position numeric;
    v_id uuid;
begin
    -- The parent row serializes append/reorder/delete for this template.
    select * into v_template
      from public.task_templates
     where id = p_template_id
     for update;

    if not found or v_template.archived_at is not null then
        raise exception 'template not found';
    end if;
    if v_template.created_by <> v_user then
        raise exception 'only template creator can edit it'
            using errcode = 'insufficient_privilege';
    end if;
    if char_length(v_title) not between 1 and 500 then
        raise exception 'template item title must contain 1..500 characters';
    end if;
    if v_description is not null and char_length(v_description) > 10000 then
        raise exception 'template item description is too long';
    end if;

    if p_position is not null and (p_position < 0 or p_position in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)) then
        raise exception 'template item position must be a non-negative finite number' using errcode = '23514';
    end if;

    -- p_position is intentionally ignored for backwards compatibility.
    -- Ordering is server-owned; every create is an append.
    select coalesce(max(position), 0) + 1
      into v_position
      from public.task_template_items
     where template_id = p_template_id;

    insert into public.task_template_items(template_id, title, description, position)
    values (p_template_id, v_title, v_description, v_position)
    returning id into v_id;

    insert into public.audit_log(user_id, action, entity_type, entity_id, new_data)
    values (
        v_user,
        'created',
        'task_template_item',
        v_id,
        jsonb_build_object(
            'template_id', p_template_id,
            'title', v_title,
            'description', v_description,
            'position', v_position
        )
    );

    return v_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.update_task_template_item(p_item_id uuid, p_title text DEFAULT NULL::text, p_description text DEFAULT NULL::text, p_position numeric DEFAULT NULL::numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'private', 'public'
AS $function$
declare
    v_user uuid := private.require_auth();
    v_template_id uuid;
    v_template public.task_templates%rowtype;
    v_item public.task_template_items%rowtype;
    v_neighbor public.task_template_items%rowtype;
    v_title text;
    v_description text;
    v_temp_position numeric;
begin
    select template_id into v_template_id
      from public.task_template_items
     where id = p_item_id;
    if not found then
        raise exception 'template item not found';
    end if;

    -- Serialize every mutation of one template through the parent.
    select * into v_template
      from public.task_templates
     where id = v_template_id
     for update;

    select * into v_item
      from public.task_template_items
     where id = p_item_id
     for update;

    if not found or v_item.template_id <> v_template_id then
        raise exception 'template item not found';
    end if;
    if v_template.archived_at is not null or v_template.created_by <> v_user then
        raise exception 'no permission to edit template item'
            using errcode = 'insufficient_privilege';
    end if;

    if p_position is not null and (p_position < 0 or p_position in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)) then
        raise exception 'template item position must be a non-negative finite number' using errcode = '23514';
    end if;

    -- Compatibility path for older clients: a position change means reorder only.
    -- Ignore stale title/description in that request, preventing lost updates.
    if p_position is not null and p_position is distinct from v_item.position then
        if p_position < v_item.position then
            select * into v_neighbor
              from public.task_template_items i
             where i.template_id = v_template_id
               and (i.position, i.created_at, i.id)
                   < (v_item.position, v_item.created_at, v_item.id)
             order by i.position desc, i.created_at desc, i.id desc
             limit 1
             for update;
        else
            select * into v_neighbor
              from public.task_template_items i
             where i.template_id = v_template_id
               and (i.position, i.created_at, i.id)
                   > (v_item.position, v_item.created_at, v_item.id)
             order by i.position asc, i.created_at asc, i.id asc
             limit 1
             for update;
        end if;

        if not found then
            return;
        end if;

        select coalesce(max(position), 0) + 1
          into v_temp_position
          from public.task_template_items
         where template_id = v_template_id;

        -- Three writes avoid transient UNIQUE collisions while remaining atomic
        -- in the surrounding RPC transaction.
        update public.task_template_items
           set position = v_temp_position
         where id = v_item.id;

        update public.task_template_items
           set position = v_item.position
         where id = v_neighbor.id;

        update public.task_template_items
           set position = v_neighbor.position
         where id = v_item.id;

        insert into public.audit_log(user_id, action, entity_type, entity_id, old_data, new_data)
        values
            (
                v_user,
                'reordered',
                'task_template_item',
                v_item.id,
                jsonb_build_object(
                    'template_id', v_template_id,
                    'title', v_item.title,
                    'description', v_item.description,
                    'position', v_item.position
                ),
                jsonb_build_object(
                    'template_id', v_template_id,
                    'title', v_item.title,
                    'description', v_item.description,
                    'position', v_neighbor.position
                )
            ),
            (
                v_user,
                'reordered',
                'task_template_item',
                v_neighbor.id,
                jsonb_build_object(
                    'template_id', v_template_id,
                    'title', v_neighbor.title,
                    'description', v_neighbor.description,
                    'position', v_neighbor.position
                ),
                jsonb_build_object(
                    'template_id', v_template_id,
                    'title', v_neighbor.title,
                    'description', v_neighbor.description,
                    'position', v_item.position
                )
            );

        return;
    end if;

    v_title := case when p_title is null then v_item.title else btrim(p_title) end;
    v_description := case
        when p_description is null then v_item.description
        else nullif(btrim(p_description), '')
    end;

    if char_length(v_title) not between 1 and 500 then
        raise exception 'template item title must contain 1..500 characters';
    end if;
    if v_description is not null and char_length(v_description) > 10000 then
        raise exception 'template item description is too long';
    end if;

    if v_title is not distinct from v_item.title
       and v_description is not distinct from v_item.description then
        return;
    end if;

    update public.task_template_items
       set title = v_title,
           description = v_description
     where id = p_item_id;

    insert into public.audit_log(user_id, action, entity_type, entity_id, old_data, new_data)
    values (
        v_user,
        'updated',
        'task_template_item',
        p_item_id,
        jsonb_build_object(
            'template_id', v_template_id,
            'title', v_item.title,
            'description', v_item.description,
            'position', v_item.position
        ),
        jsonb_build_object(
            'template_id', v_template_id,
            'title', v_title,
            'description', v_description,
            'position', v_item.position
        )
    );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.move_task_template_item(p_item_id uuid, p_direction integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'private', 'public'
AS $function$
declare
    v_user uuid := private.require_auth();
    v_template_id uuid;
    v_template public.task_templates%rowtype;
    v_item public.task_template_items%rowtype;
    v_neighbor public.task_template_items%rowtype;
begin
    if p_direction is null or p_direction not in (-1, 1) then
        raise exception 'direction must be -1 or 1' using errcode = '22023';
    end if;

    select template_id into v_template_id
      from public.task_template_items
     where id = p_item_id;
    if not found then
        raise exception 'template item not found';
    end if;

    select * into v_template
      from public.task_templates
     where id = v_template_id
     for update;

    select * into v_item
      from public.task_template_items
     where id = p_item_id
     for update;

    if not found or v_item.template_id <> v_template_id then
        raise exception 'template item not found';
    end if;
    if v_template.archived_at is not null or v_template.created_by <> v_user then
        raise exception 'no permission to reorder template item'
            using errcode = 'insufficient_privilege';
    end if;

    if p_direction = -1 then
        select * into v_neighbor
          from public.task_template_items i
         where i.template_id = v_template_id
           and (i.position, i.created_at, i.id)
               < (v_item.position, v_item.created_at, v_item.id)
         order by i.position desc, i.created_at desc, i.id desc
         limit 1
         for update;
    else
        select * into v_neighbor
          from public.task_template_items i
         where i.template_id = v_template_id
           and (i.position, i.created_at, i.id)
               > (v_item.position, v_item.created_at, v_item.id)
         order by i.position asc, i.created_at asc, i.id asc
         limit 1
         for update;
    end if;

    if not found then
        return;
    end if;

    -- Reuse the compatibility-safe swap path without sending stale text.
    perform public.update_task_template_item(
        p_item_id,
        null,
        null,
        v_neighbor.position
    );
end;
$function$
;

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

    for v_item in
        select
            title,
            description,
            row_number() over (
                order by position, created_at, id
            )::numeric as dense_position
        from public.task_template_items
        where template_id = p_template_id
        order by position, created_at, id
    loop
        insert into public.task_items(
            task_id, title, description, position, is_completed, percentage, comment
        )
        values (
            v_task_id,
            v_item.title,
            v_item.description,
            v_item.dense_position,
            false,
            0,
            null
        );
    end loop;

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
-- Existing invoker view must never become a privileged service-role CRUD API.
CREATE OR REPLACE FUNCTION public.mark_all_notifications_read()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
        begin
            update public.notifications set is_read = true, read_at = coalesce(read_at, now())
             where user_id = (select auth.uid()) and not is_read;
        end
        $function$
;

CREATE OR REPLACE FUNCTION public.mark_notification_read(p_notification_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
        begin
            update public.notifications set is_read = true, read_at = coalesce(read_at, now())
             where id = p_notification_id and user_id = (select auth.uid());
        end
        $function$
;

revoke all on public.checklist_overview from service_role;

-- Validate only already-enforced text checks where legacy rows permit it.
-- Invalid historical content is preserved: NOT VALID still enforces all future
-- writes. Validation state may legitimately differ with legacy data.
do $migration$
declare r record;
begin
  for r in select c.conname,c.conrelid::regclass as relation
    from pg_constraint c join pg_namespace n on n.oid=c.connamespace
    where n.nspname='public' and c.contype='c' and not c.convalidated
      and c.conname in ('profiles_display_name_valid','projects_name_length_chk',
        'projects_description_length_chk','tasks_title_length_chk','tasks_description_length_chk',
        'task_items_title_length_chk','task_items_description_length_chk','task_items_comment_length_chk',
        'task_templates_name_chk')
  loop
    begin
      execute format('alter table %s validate constraint %I',r.relation,r.conname);
    exception when check_violation then
      raise notice 'Legacy rows retained; constraint % remains NOT VALID',r.conname;
    end;
  end loop;
end $migration$;
commit;
