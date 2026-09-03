-- Phase A: forward-only, additive hosted reconciliation.
-- No existing function is replaced. Existing objects are shape-checked.

do $type$
declare
    labels text[];
begin
    if to_regtype('public.notification_type') is null then
        create type public.notification_type as enum (
            'task_member_added', 'task_member_removed', 'task_assigned', 'task_unassigned',
            'task_item_changed', 'task_item_checked', 'task_item_unchecked'
        );
    else
        select array_agg(e.enumlabel order by e.enumsortorder)
          into labels
          from pg_type t
          join pg_namespace n on n.oid = t.typnamespace
          join pg_enum e on e.enumtypid = t.oid
         where n.nspname = 'public' and t.typname = 'notification_type';
        if labels is distinct from array[
            'task_member_added', 'task_member_removed', 'task_assigned', 'task_unassigned',
            'task_item_changed', 'task_item_checked', 'task_item_unchecked'
        ]::text[] then
            raise exception 'Phase A abort: public.notification_type labels mismatch: %', labels;
        end if;
    end if;
end
$type$;

do $table$
declare
    expected text[] := array[
        'id uuid NOT NULL', 'user_id uuid NOT NULL', 'project_id uuid', 'task_id uuid',
        'type notification_type NOT NULL', 'title text NOT NULL', 'body text NOT NULL',
        'data jsonb NOT NULL', 'is_read boolean NOT NULL', 'created_at timestamp with time zone NOT NULL',
        'read_at timestamp with time zone', 'dedupe_key text NOT NULL'
    ];
    actual text[];
begin
    if to_regclass('public.notifications') is null then
        create table public.notifications (
            id uuid primary key default gen_random_uuid(),
            user_id uuid not null references auth.users(id) on delete cascade,
            project_id uuid references public.projects(id) on delete set null,
            task_id uuid references public.tasks(id) on delete set null,
            type public.notification_type not null,
            title text not null,
            body text not null,
            data jsonb not null default '{}'::jsonb,
            is_read boolean not null default false,
            created_at timestamptz not null default now(),
            read_at timestamptz,
            dedupe_key text not null,
            constraint notifications_read_consistency check ((is_read and read_at is not null) or (not is_read and read_at is null))
        );
    else
        select array_agg(a.attname || ' ' || pg_catalog.format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' NOT NULL' else '' end order by a.attnum)
          into actual
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = 'notifications'
           and a.attnum > 0 and not a.attisdropped;
        if actual is distinct from expected then
            raise exception 'Phase A abort: public.notifications shape mismatch: %', actual;
        end if;
        if not exists (select 1 from pg_constraint where conrelid = 'public.notifications'::regclass and conname = 'notifications_read_consistency') then
            raise exception 'Phase A abort: notifications_read_consistency constraint is missing';
        end if;
    end if;
end
$table$;

create unique index if not exists ux_notifications_dedupe on public.notifications(user_id, dedupe_key);
create index if not exists idx_notifications_user_created on public.notifications(user_id, created_at desc);
create index if not exists idx_notifications_user_read_created on public.notifications(user_id, is_read, created_at desc);

alter table public.notifications enable row level security;
do $policy$
begin
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'notifications_select_own') then
        if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications' and policyname = 'notifications_select_own' and cmd = 'SELECT' and roles = array['authenticated']::name[] and (qual = '(user_id = ( SELECT auth.uid() AS uid))' or qual = '(user_id = auth.uid())')) then
            raise exception 'Phase A abort: notifications_select_own policy shape mismatch';
        end if;
    else
        create policy notifications_select_own on public.notifications for select to authenticated using (user_id = (select auth.uid()));
    end if;
end
$policy$;
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;

do $rpc$
begin
    if to_regprocedure('public.mark_notification_read(uuid)') is null then
        execute $fn$create function public.mark_notification_read(p_notification_id uuid)
        returns void language plpgsql security definer set search_path = public as $$
        begin
            update public.notifications set is_read = true, read_at = coalesce(read_at, now())
             where id = p_notification_id and user_id = (select auth.uid());
        end
        $$;$fn$;
    else
        if not exists (select 1 from pg_proc p where p.oid = 'public.mark_notification_read(uuid)'::regprocedure and p.prosecdef and p.proconfig @> array['search_path=public']::text[] and pg_get_functiondef(p.oid) like '%auth.uid()%' and pg_get_functiondef(p.oid) like '%update public.notifications%') then
            raise exception 'Phase A abort: mark_notification_read shape/security mismatch';
        end if;
    end if;
    if to_regprocedure('public.mark_all_notifications_read()') is null then
        execute $fn$create function public.mark_all_notifications_read()
        returns void language plpgsql security definer set search_path = public as $$
        begin
            update public.notifications set is_read = true, read_at = coalesce(read_at, now())
             where user_id = (select auth.uid()) and not is_read;
        end
        $$;$fn$;
    else
        if not exists (select 1 from pg_proc p where p.oid = 'public.mark_all_notifications_read()'::regprocedure and p.prosecdef and p.proconfig @> array['search_path=public']::text[] and pg_get_functiondef(p.oid) like '%auth.uid()%' and pg_get_functiondef(p.oid) like '%update public.notifications%') then
            raise exception 'Phase A abort: mark_all_notifications_read shape/security mismatch';
        end if;
    end if;
end
$rpc$;
revoke all on function public.mark_notification_read(uuid), public.mark_all_notifications_read() from public, anon;
grant execute on function public.mark_notification_read(uuid), public.mark_all_notifications_read() to authenticated, service_role;

do $helper$
begin
    if to_regprocedure('private.create_notification(uuid,uuid,uuid,public.notification_type,text,text,jsonb,text)') is null then
        execute $fn$create function private.create_notification(
            p_user_id uuid, p_project_id uuid, p_task_id uuid, p_type public.notification_type,
            p_title text, p_body text, p_data jsonb, p_dedupe_key text
        ) returns void language sql security definer set search_path = public, private as $$
            insert into public.notifications(user_id, project_id, task_id, type, title, body, data, dedupe_key)
            values (p_user_id, p_project_id, p_task_id, p_type, p_title, p_body, coalesce(p_data, '{}'::jsonb), p_dedupe_key)
            on conflict (user_id, dedupe_key) do nothing;
        $$;$fn$;
    else
        if not exists (select 1 from pg_proc p where p.oid = 'private.create_notification(uuid,uuid,uuid,public.notification_type,text,text,jsonb,text)'::regprocedure and p.prosecdef and p.proconfig @> array['search_path=public, private']::text[] and pg_get_functiondef(p.oid) like '%on conflict (user_id, dedupe_key) do nothing%') then
            raise exception 'Phase A abort: private.create_notification shape/security mismatch';
        end if;
    end if;
    if to_regprocedure('private.audit_to_notification()') is null then
        execute $fn$create function private.audit_to_notification()
        returns trigger language plpgsql security definer set search_path = public, private as $body$
        declare
            v_task_id uuid := (new.new_data->>'task_id')::uuid;
            v_type public.notification_type;
            v_title text; v_body text; v_recipient uuid;
        begin
            if new.action = 'access_approved' then v_type := 'task_member_added'; v_recipient := new.entity_id; v_title := 'Доступ к задаче предоставлен'; v_body := 'Вас добавили в задачу';
            elsif new.action = 'access_revoked' then v_type := 'task_member_removed'; v_recipient := new.entity_id; v_title := 'Доступ к задаче отозван'; v_body := 'Ваш доступ к задаче был отозван';
            elsif new.action = 'assignee_added' then v_type := 'task_assigned'; v_recipient := new.entity_id; v_title := 'Вас назначили ответственным'; v_body := 'Вас назначили ответственным за задачу';
            elsif new.action = 'assignee_removed' then v_type := 'task_unassigned'; v_recipient := new.entity_id; v_title := 'Назначение снято'; v_body := 'Вас больше не назначили ответственным за задачу';
            elsif new.action in ('checked', 'unchecked') then v_type := case when new.action = 'checked' then 'task_item_checked' else 'task_item_unchecked' end; v_title := case when new.action = 'checked' then 'Пункт отмечен' else 'Отметка пункта снята' end; v_body := 'Изменилось состояние пункта чек-листа'; select task_id into v_task_id from public.task_items where id = new.entity_id;
            elsif new.action = 'updated' and (new.new_data ? 'title' or new.new_data ? 'description') then v_type := 'task_item_changed'; v_title := 'Изменён пункт чек-листа'; v_body := 'Изменился текст пункта чек-листа'; select task_id into v_task_id from public.task_items where id = new.entity_id;
            else return new; end if;
            if v_task_id is null then return new; end if;
            if new.action in ('checked','unchecked','updated') then
                for v_recipient in select tm.user_id from public.task_members tm where tm.task_id = v_task_id and tm.user_id <> coalesce(new.user_id, '00000000-0000-0000-0000-000000000000') loop
                    perform private.create_notification(v_recipient, new.project_id, v_task_id, v_type, v_title, v_body, jsonb_build_object('task_id', v_task_id, 'entity_id', new.entity_id), 'audit:' || new.id::text);
                end loop;
            elsif v_recipient is not null and v_recipient <> coalesce(new.user_id, '00000000-0000-0000-0000-000000000000') then
                perform private.create_notification(v_recipient, new.project_id, v_task_id, v_type, v_title, v_body, jsonb_build_object('task_id', v_task_id), 'audit:' || new.id::text);
            end if;
            return new;
        end
        $body$;$fn$;
    else
        if not exists (select 1 from pg_proc p where p.oid = 'private.audit_to_notification()'::regprocedure and p.prosecdef and p.proconfig @> array['search_path=public, private']::text[] and pg_get_functiondef(p.oid) like '%private.create_notification%') then
            raise exception 'Phase A abort: private.audit_to_notification shape/security mismatch';
        end if;
    end if;
end
$helper$;
revoke all on function private.create_notification(uuid, uuid, uuid, public.notification_type, text, text, jsonb, text), private.audit_to_notification() from public, anon, authenticated;

do $trigger$
begin
    if not exists (select 1 from pg_trigger where tgrelid = 'public.audit_log'::regclass and tgname = 'trg_audit_log_notifications') then
        create trigger trg_audit_log_notifications after insert on public.audit_log for each row execute function private.audit_to_notification();
    elsif not exists (select 1 from pg_trigger t where t.tgrelid = 'public.audit_log'::regclass and t.tgname = 'trg_audit_log_notifications' and pg_get_triggerdef(t.oid, true) like '%private.audit_to_notification()%') then
        raise exception 'Phase A abort: trg_audit_log_notifications definition mismatch';
    end if;
end
$trigger$;

do $publication$
begin
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
        alter publication supabase_realtime add table public.notifications;
    end if;
end
$publication$;
