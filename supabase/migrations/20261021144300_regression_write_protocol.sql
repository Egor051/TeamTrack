-- Controlled cutover of unsafe draft writes. Apply only in the approved server-first release window.
-- Keep historical migrations immutable. Original locking, ACL, validation and audit
-- implementations become private; only CAS entry points may call them.
begin;
set local lock_timeout = '5s';

alter function public.update_project(uuid,text,text) set schema private;
alter function private.update_project(uuid,text,text) rename to update_project_unchecked;
revoke all on function private.update_project_unchecked(uuid,text,text) from public,anon,authenticated,service_role;

alter function public.update_task(uuid,text,text) set schema private;
alter function private.update_task(uuid,text,text) rename to update_task_unchecked;
revoke all on function private.update_task_unchecked(uuid,text,text) from public,anon,authenticated,service_role;

alter function public.update_task_template(uuid,text,text) set schema private;
alter function private.update_task_template(uuid,text,text) rename to update_task_template_unchecked;
revoke all on function private.update_task_template_unchecked(uuid,text,text) from public,anon,authenticated,service_role;

alter function public.update_task_template_item(uuid,text,text,numeric) set schema private;
alter function private.update_task_template_item(uuid,text,text,numeric) rename to update_task_template_item_unchecked;
revoke all on function private.update_task_template_item_unchecked(uuid,text,text,numeric) from public,anon,authenticated,service_role;

alter function public.update_task_item(uuid,text,text,numeric) set schema private;
alter function private.update_task_item(uuid,text,text,numeric) rename to update_task_item_unchecked;
revoke all on function private.update_task_item_unchecked(uuid,text,text,numeric) from public,anon,authenticated,service_role;

alter function public.set_task_item_comment(uuid,text) set schema private;
alter function private.set_task_item_comment(uuid,text) rename to set_task_item_comment_unchecked;
revoke all on function private.set_task_item_comment_unchecked(uuid,text) from public,anon,authenticated,service_role;

alter function public.set_task_item_percentage(uuid,integer) set schema private;
alter function private.set_task_item_percentage(uuid,integer) rename to set_task_item_percentage_unchecked;
revoke all on function private.set_task_item_percentage_unchecked(uuid,integer) from public,anon,authenticated,service_role;

alter function public.set_task_item_state(uuid,boolean) set schema private;
alter function private.set_task_item_state(uuid,boolean) rename to set_task_item_state_unchecked;
revoke all on function private.set_task_item_state_unchecked(uuid,boolean) from public,anon,authenticated,service_role;

alter function public.update_my_profile(text) set schema private;
alter function private.update_my_profile(text) rename to update_my_profile_unchecked;
revoke all on function private.update_my_profile_unchecked(text) from public,anon,authenticated,service_role;

create function private.require_write_protocol()
returns void language plpgsql set search_path='' as $$
begin
  raise exception 'Обновите приложение перед сохранением. Черновик не отправлен: эта версия клиента не поддерживает безопасную запись.'
    using errcode='PT426', hint='Сохраните черновик, закройте старые вкладки и откройте обновлённое приложение. Не очищайте несинхронизированную очередь.';
end $$;
revoke all on function private.require_write_protocol() from public,anon,authenticated,service_role;

create function public.update_project(p_project_id uuid,p_name text,p_description text)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.require_auth();
  perform private.require_write_protocol();
end $$;
revoke all on function public.update_project(uuid,text,text) from public,anon,service_role;
grant execute on function public.update_project(uuid,text,text) to authenticated;

create function public.update_task(p_task_id uuid,p_title text default null,p_description text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.require_auth();
  perform private.require_write_protocol();
end $$;
revoke all on function public.update_task(uuid,text,text) from public,anon,service_role;
grant execute on function public.update_task(uuid,text,text) to authenticated;

create function public.update_task_template(p_template_id uuid,p_name text default null,p_description text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.require_auth();
  perform private.require_write_protocol();
end $$;
revoke all on function public.update_task_template(uuid,text,text) from public,anon,service_role;
grant execute on function public.update_task_template(uuid,text,text) to authenticated;

create function public.update_task_template_item(p_item_id uuid,p_title text default null,p_description text default null,p_position numeric default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.require_auth();
  perform private.require_write_protocol();
end $$;
revoke all on function public.update_task_template_item(uuid,text,text,numeric) from public,anon,service_role;
grant execute on function public.update_task_template_item(uuid,text,text,numeric) to authenticated;

create function public.update_task_item(p_task_item_id uuid,p_title text default null,p_description text default null,p_position numeric default null)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.require_auth();
  perform private.require_write_protocol();
end $$;
revoke all on function public.update_task_item(uuid,text,text,numeric) from public,anon,service_role;
grant execute on function public.update_task_item(uuid,text,text,numeric) to authenticated;

create function public.set_task_item_comment(p_task_item_id uuid,p_comment text)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform private.require_auth();
  perform private.require_write_protocol();
end $$;
revoke all on function public.set_task_item_comment(uuid,text) from public,anon,service_role;
grant execute on function public.set_task_item_comment(uuid,text) to authenticated;

create function public.set_task_item_percentage(p_task_item_id uuid,p_percentage integer)
returns integer language plpgsql security definer set search_path='' as $$
begin
  perform private.require_auth();
  perform private.require_write_protocol();
  return null;
end $$;
revoke all on function public.set_task_item_percentage(uuid,integer) from public,anon,service_role;
grant execute on function public.set_task_item_percentage(uuid,integer) to authenticated;

create function public.set_task_item_state(p_task_item_id uuid,p_completed boolean)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform private.require_auth();
  perform private.require_write_protocol();
  return null;
end $$;
revoke all on function public.set_task_item_state(uuid,boolean) from public,anon,service_role;
grant execute on function public.set_task_item_state(uuid,boolean) to authenticated;

create function public.update_my_profile(p_display_name text)
returns public.profiles language plpgsql security definer set search_path='' as $$
begin
  perform private.require_auth();
  perform private.require_write_protocol();
  return null;
end $$;
revoke all on function public.update_my_profile(text) from public,anon,service_role;
grant execute on function public.update_my_profile(text) to authenticated;

create or replace function public.update_project(p_project_id uuid, p_name text, p_description text,
  p_expected_name text, p_expected_description text)
returns void language plpgsql security definer set search_path = private, public as $$
declare v_user uuid := private.require_auth(); v_row public.projects%rowtype;
begin
  perform pg_catalog.set_config('tasktrace.write_protocol','3',true);
  v_row := private.lock_project_state(p_project_id);
  if private.lock_project_role(p_project_id, v_user) not in ('owner','admin')
     or private.is_project_admin(p_project_id) is not true then
    raise exception 'project admin role required' using errcode = '42501';
  end if;
  if v_row.name is distinct from p_expected_name
     or coalesce(v_row.description,'') is distinct from coalesce(p_expected_description,'') then
    raise exception 'Проект изменён другим участником. Обновите данные, ваш черновик сохранён.' using errcode = 'PT409';
  end if;
  perform private.update_project_unchecked(p_project_id, p_name, p_description);
end; $$;

create or replace function public.update_task_template(p_template_id uuid, p_name text, p_description text,
  p_expected_name text, p_expected_description text)
returns void language plpgsql security definer set search_path = private, public as $$
declare v_user uuid := private.require_auth(); v_row public.task_templates%rowtype;
begin
  perform pg_catalog.set_config('tasktrace.write_protocol','3',true);
  select * into v_row from public.task_templates where id=p_template_id for update;
  if not found or v_row.archived_at is not null then raise exception 'template not found'; end if;
  if v_row.created_by <> v_user then raise exception 'only template creator can edit it' using errcode='42501'; end if;
  if v_row.name is distinct from p_expected_name
     or coalesce(v_row.description,'') is distinct from coalesce(p_expected_description,'') then
    raise exception 'Шаблон изменён. Обновите данные, ваш черновик сохранён.' using errcode = 'PT409';
  end if;
  perform private.update_task_template_unchecked(p_template_id, p_name, p_description);
end; $$;

create or replace function public.update_task_template_item(p_item_id uuid, p_title text, p_description text,
  p_expected_title text, p_expected_description text, p_position numeric default null)
returns void language plpgsql security definer set search_path = private, public as $$
declare v_user uuid := private.require_auth(); v_template_id uuid; v_template public.task_templates%rowtype;
  v_item public.task_template_items%rowtype;
begin
  perform pg_catalog.set_config('tasktrace.write_protocol','3',true);
  select template_id into v_template_id from public.task_template_items where id=p_item_id;
  if not found then raise exception 'template item not found'; end if;
  select * into v_template from public.task_templates where id=v_template_id for update;
  if not found or v_template.archived_at is not null or v_template.created_by<>v_user then
    raise exception 'no permission to edit template item' using errcode='42501';
  end if;
  select * into v_item from public.task_template_items where id=p_item_id for update;
  if not found or v_item.template_id<>v_template_id then raise exception 'template item not found'; end if;
  if v_item.title is distinct from p_expected_title or coalesce(v_item.description,'') is distinct from coalesce(p_expected_description,'') then
    raise exception 'Пункт шаблона изменён. Ваш черновик сохранён.' using errcode='PT409';
  end if;
  if p_position is not null then perform private.require_write_protocol(); end if;
  perform private.update_task_template_item_unchecked(p_item_id,p_title,p_description,p_position);
end; $$;

create or replace function public.update_task(p_task_id uuid,p_title text,p_description text,p_expected_title text,p_expected_description text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_task public.tasks%rowtype; v_actor uuid := private.require_auth();
begin
  perform pg_catalog.set_config('tasktrace.write_protocol','3',true);
  perform private.lock_project_state(private.task_project_id(p_task_id));
  v_task := private.lock_task(p_task_id);
  if private.is_project_admin(v_task.project_id,v_actor) is not true then raise exception 'only owner/admin can edit stage details' using errcode='42501'; end if;
  if v_task.title is distinct from p_expected_title or coalesce(v_task.description,'') is distinct from coalesce(p_expected_description,'') then
    if v_task.title=btrim(p_title) and v_task.description is not distinct from nullif(btrim(p_description),'') then return; end if;
    raise exception 'Этап изменён другим участником. Обновите данные и проверьте сохранённый черновик.' using errcode='PT409';
  end if;
  perform private.update_task_unchecked(p_task_id,p_title,p_description);
end $$;

create or replace function public.update_task_item(p_task_item_id uuid,p_title text,p_expected_version bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.set_config('tasktrace.write_protocol','3',true);
  perform private.lock_task_item_version(p_task_item_id,p_expected_version);
  perform private.update_task_item_unchecked(p_task_item_id,p_title,null::text,null::numeric);
end $$;

create or replace function public.set_task_item_comment(p_task_item_id uuid,p_comment text,p_expected_version bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.set_config('tasktrace.write_protocol','3',true);
  perform private.lock_task_item_version(p_task_item_id,p_expected_version);
  perform private.set_task_item_comment_unchecked(p_task_item_id,p_comment);
end $$;

create or replace function public.set_task_item_percentage(p_task_item_id uuid,p_percentage integer,p_expected_version bigint)
returns integer language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.set_config('tasktrace.write_protocol','3',true);
  perform private.lock_task_item_version(p_task_item_id,p_expected_version);
  return private.set_task_item_percentage_unchecked(p_task_item_id,p_percentage);
end $$;

create or replace function public.set_task_item_state(p_task_item_id uuid,p_completed boolean,p_expected_version bigint)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.set_config('tasktrace.write_protocol','3',true);
  perform private.lock_task_item_version(p_task_item_id,p_expected_version);
  return private.set_task_item_state_unchecked(p_task_item_id,p_completed);
end $$;

create or replace function private.apply_task_item_operation_v2(
    p_operation_id uuid, p_task_item_id uuid, p_expected_version bigint,
    p_kind text, p_payload jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
    v_user uuid := private.require_auth();
    v_claimed boolean;
    v_saved jsonb;
    v_task_id uuid;
    v_project_id uuid;
    v_project public.projects%rowtype;
    v_task public.tasks%rowtype;
    v_role public.project_role;
    v_item public.task_items%rowtype;
    v_result jsonb;
begin
  perform pg_catalog.set_config('tasktrace.write_protocol','3',true);
    if p_expected_version is null or p_expected_version < 1 then
        raise exception 'expected_version is required' using errcode = '22023';
    end if;
    if p_kind not in ('set_task_item_state', 'set_task_item_percentage', 'set_task_item_comment') then
        raise exception 'invalid operation type' using errcode = '22023';
    end if;
    select claimed, saved_result into v_claimed, v_saved
      from private.claim_client_operation(p_operation_id, p_kind || '_v2', p_task_item_id, p_payload);
    if not v_claimed then return v_saved; end if;

    select task_id into v_task_id from public.task_items where id = p_task_item_id;
    if not found then raise exception 'task item not found' using errcode = '42501'; end if;
    v_project_id := private.task_project_id(v_task_id);
    if v_project_id is null then raise exception 'task not found' using errcode = '42501'; end if;
    v_project := private.lock_project_state(v_project_id);
    v_task := private.lock_task(v_task_id);
    v_role := private.lock_task_role(v_task_id, v_project_id, v_user);
    select * into v_item from public.task_items where id = p_task_item_id for update;
    if not found or v_item.task_id <> v_task_id or v_role is null
       or v_role not in ('owner', 'admin', 'member') then
        raise exception 'no access to task item' using errcode = '42501';
    end if;
    if v_item.is_archived or v_task.status = 'archived' or v_project.status <> 'active' then
        raise exception 'task item is archived' using errcode = '42501';
    end if;
    if v_item.sync_version <> p_expected_version then
        delete from private.client_operation_receipts
         where user_id = v_user and operation_id = p_operation_id;
        return pg_catalog.jsonb_build_object('status', 'conflict', 'version', v_item.sync_version,
            'item', pg_catalog.to_jsonb(v_item));
    end if;

    if p_kind = 'set_task_item_state' then
        perform private.set_task_item_state_unchecked(p_task_item_id, (p_payload ->> 'completed')::boolean);
    elsif p_kind = 'set_task_item_percentage' then
        perform private.set_task_item_percentage_unchecked(p_task_item_id, (p_payload ->> 'percentage')::integer);
    else
        perform private.set_task_item_comment_unchecked(p_task_item_id, p_payload ->> 'comment');
    end if;
    select * into v_item from public.task_items where id = p_task_item_id;
    -- An accepted semantic no-op still advances the protocol version so the
    -- next queued operation always has a fresh, unambiguous precondition.
    if v_item.sync_version = p_expected_version then
        perform pg_catalog.set_config('tasktrace.force_sync_version_bump', 'on', true);
        update public.task_items set sync_version = sync_version where id = p_task_item_id;
        perform pg_catalog.set_config('tasktrace.force_sync_version_bump', 'off', true);
        select * into v_item from public.task_items where id = p_task_item_id;
    end if;
    v_result := pg_catalog.jsonb_build_object('status', 'applied', 'version', v_item.sync_version,
        'item', pg_catalog.to_jsonb(v_item));
    update private.client_operation_receipts
       set result_payload = v_result, completed_at = now()
     where user_id = v_user and operation_id = p_operation_id;
    return v_result;
end;
$$;

-- Profile drafts can also race between two sessions of the same account.
-- Full item edits retain description/position support with the same row version.
create function public.update_task_item(p_task_item_id uuid,p_title text,p_description text,p_position numeric,p_expected_version bigint)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.set_config('tasktrace.write_protocol','3',true);
  perform private.lock_task_item_version(p_task_item_id,p_expected_version);
  perform private.update_task_item_unchecked(p_task_item_id,p_title,p_description,p_position);
end $$;
revoke all on function public.update_task_item(uuid,text,text,numeric,bigint) from public,anon,service_role;
grant execute on function public.update_task_item(uuid,text,text,numeric,bigint) to authenticated;

create function public.update_my_profile(p_display_name text,p_expected_display_name text)
returns public.profiles language plpgsql security definer set search_path='' as $$
declare v_user uuid := private.require_auth(); v_old public.profiles%rowtype;
begin
  perform pg_catalog.set_config('tasktrace.write_protocol','3',true);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('profile:'||v_user::text,0));
  v_old := private.ensure_profile(v_user);
  if v_old.display_name is distinct from p_expected_display_name then
    raise exception 'Профиль изменён в другой вкладке. Ваш черновик сохранён.' using errcode='PT409';
  end if;
  return private.update_my_profile_unchecked(p_display_name);
end $$;
revoke all on function public.update_my_profile(text,text) from public,anon,service_role;
grant execute on function public.update_my_profile(text,text) to authenticated;

-- Legacy v1 outbox wrappers keep completed receipt replay. An unseen operation
-- reaches the public refusal above and rolls back its claimed receipt, leaving
-- the local draft/queue intact. v2 uses the private setter after its CAS check.
-- The security-invoker progress alias also reaches that controlled refusal.
-- Drain existing table writers before publishing the cutover atomically.
-- An old function already waiting on a project lock can still have its old
-- body in flight: the trigger rejects its eventual unversioned UPDATE too.
lock table public.profiles,public.projects,public.tasks,public.task_items,
  public.task_templates,public.task_template_items in share row exclusive mode;
create function private.guard_draft_write_protocol()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_field text;
begin
  -- Explicit privileged SQL maintenance is outside the client protocol.
  if session_user in ('postgres','supabase_admin') and current_setting('role') in ('none','postgres','supabase_admin') then return new; end if;
  if current_setting('tasktrace.write_protocol',true)='3' then return new; end if;
  foreach v_field in array tg_argv loop
    if to_jsonb(new)->v_field is distinct from to_jsonb(old)->v_field then
      perform private.require_write_protocol();
    end if;
  end loop;
  return new;
end $$;
revoke all on function private.guard_draft_write_protocol() from public,anon,authenticated,service_role;
create trigger trg_draft_write_protocol before update on public.profiles for each row execute function private.guard_draft_write_protocol('display_name');
create trigger trg_draft_write_protocol before update on public.projects for each row execute function private.guard_draft_write_protocol('name','description');
create trigger trg_draft_write_protocol before update on public.tasks for each row execute function private.guard_draft_write_protocol('title','description');
create trigger trg_draft_write_protocol before update on public.task_items for each row execute function private.guard_draft_write_protocol('title','description','position','percentage','is_completed','comment');
create trigger trg_draft_write_protocol before update on public.task_templates for each row execute function private.guard_draft_write_protocol('name','description');
create trigger trg_draft_write_protocol before update on public.task_template_items for each row execute function private.guard_draft_write_protocol('title','description','position');

-- Relative order/insert/delete are atomic commands, not stale draft writes.
-- Keep their exact deployed implementation and ACL, adding only the write fence.
do $$
declare v_signature text; v_definition text; v_updated text;
begin
  foreach v_signature in array array['public.create_task_template_item(uuid,text,text,numeric)',
    'public.move_task_template_item(uuid,integer)','public.delete_task_template_item(uuid)'] loop
    v_definition := pg_get_functiondef(v_signature::regprocedure);
    v_updated := replace(v_definition,E'\nbegin\n',E'\nbegin\n  perform pg_catalog.set_config(''tasktrace.write_protocol'',''3'',true);\n');
    if v_updated=v_definition then raise exception 'Unexpected mutation body: %',v_signature; end if;
    -- The relative-order command delegates its locked position-only edit to
    -- the original implementation, never through the retired public API.
    v_updated := replace(v_updated,'public.update_task_template_item(', 'private.update_task_template_item_unchecked(');
    execute v_updated;
  end loop;
end $$;

notify pgrst,'reload schema';
commit;
