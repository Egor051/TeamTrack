-- Phase B: ACL and policy hardening only. Business RPC implementations are untouched.

do $functions$
begin
    if to_regprocedure('private.audit_log_visible(uuid,text,uuid,jsonb,jsonb)') is null then
        execute $fn$create function private.audit_log_visible(
            p_project_id uuid, p_entity_type text, p_entity_id uuid,
            p_old_data jsonb, p_new_data jsonb
        ) returns boolean language plpgsql stable security definer
        set search_path = private, public as $body$
        declare v_task_id uuid;
        begin
            if p_entity_type in ('project', 'project_member') then return private.is_project_member(p_project_id); end if;
            if p_entity_type = 'task' then return p_entity_id is not null and private.task_project_id(p_entity_id) = p_project_id and private.has_task_access(p_entity_id); end if;
            if p_entity_type = 'task_item' then return exists (select 1 from public.task_items ti where ti.id = p_entity_id and private.task_project_id(ti.task_id) = p_project_id and private.has_task_access(ti.task_id)); end if;
            if p_entity_type in ('task_member', 'task_assignee') then
                begin v_task_id := nullif(coalesce(p_new_data->>'task_id', p_old_data->>'task_id'), '')::uuid; exception when invalid_text_representation then return false; end;
                return v_task_id is not null and private.task_project_id(v_task_id) = p_project_id and private.has_task_access(v_task_id);
            end if;
            return false;
        end
        $body$;$fn$;
    else
        if not exists (select 1 from pg_proc p where p.oid = 'private.audit_log_visible(uuid,text,uuid,jsonb,jsonb)'::regprocedure and p.prosecdef and p.proconfig @> array['search_path=private, public']::text[] and pg_get_functiondef(p.oid) like '%private.has_task_access%') then
            raise exception 'Phase B abort: private.audit_log_visible shape/security mismatch';
        end if;
    end if;
    if to_regprocedure('private.can_view_profile(uuid)') is null then
        execute $fn$create function private.can_view_profile(p_profile_id uuid)
        returns boolean language sql stable security definer set search_path = private, public as $body$
            select exists (
                select 1 from public.project_members viewer
                join public.project_members target on target.project_id = viewer.project_id
                where viewer.user_id = auth.uid() and target.user_id = p_profile_id
            );
        $body$;$fn$;
    else
        if not exists (select 1 from pg_proc p where p.oid = 'private.can_view_profile(uuid)'::regprocedure and p.prosecdef and p.proconfig @> array['search_path=private, public']::text[] and pg_get_functiondef(p.oid) like '%project_members%') then
            raise exception 'Phase B abort: private.can_view_profile shape/security mismatch';
        end if;
    end if;
end
$functions$;

do $acl$
begin
    revoke insert, update, delete, truncate on public.projects, public.tasks,
        public.project_members, public.task_members, public.task_assignees,
        public.task_items, public.item_actions, public.audit_log from authenticated;
    revoke update, delete, truncate on public.profiles from authenticated;
    grant select on public.projects, public.tasks, public.profiles, public.project_members,
        public.task_members, public.task_assignees, public.task_items,
        public.item_actions, public.audit_log to authenticated;
    grant insert on public.profiles to authenticated;
    grant update (display_name, avatar_url) on public.profiles to authenticated;
end
$acl$;

do $helpers$
begin
    revoke all on all functions in schema private from public, anon, authenticated;
    revoke usage on schema private from public, anon;
    grant usage on schema private to authenticated;
    grant execute on function
        private.is_project_member(uuid, uuid), private.is_project_admin(uuid, uuid),
        private.project_is_active(uuid), private.has_task_access(uuid, uuid),
        private.has_project_view_of_task(uuid, uuid), private.can_edit_task(uuid, uuid),
        private.audit_log_visible(uuid, text, uuid, jsonb, jsonb), private.can_view_profile(uuid)
        to authenticated;
end
$helpers$;

-- Any mutable private helper that lacks an explicit path is fixed without replacing it.
do $paths$
declare r record;
begin
    for r in
        select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) args
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'private'
           and not coalesce(p.proconfig, '{}'::text[]) @> array['search_path=private, public']::text[]
    loop
        execute format('alter function %I.%I(%s) set search_path = private, public', r.nspname, r.proname, r.args);
    end loop;
end
$paths$;

do $policies$
begin
    if exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_select_all') then
        alter policy profiles_select_all on public.profiles using (id = (select auth.uid()) or private.can_view_profile(id));
        alter policy profiles_select_all on public.profiles rename to profiles_select_related;
    elsif exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_select_related') then
        alter policy profiles_select_related on public.profiles using (id = (select auth.uid()) or private.can_view_profile(id));
    else
        create policy profiles_select_related on public.profiles for select to authenticated using (id = (select auth.uid()) or private.can_view_profile(id));
    end if;
    if exists (select 1 from pg_policies where schemaname='public' and tablename='audit_log' and policyname='audit_log_select_project_member') then
        alter policy audit_log_select_project_member on public.audit_log using (private.audit_log_visible(project_id, entity_type, entity_id, old_data, new_data));
        alter policy audit_log_select_project_member on public.audit_log rename to audit_log_select_scoped;
    elsif exists (select 1 from pg_policies where schemaname='public' and tablename='audit_log' and policyname='audit_log_select_scoped') then
        alter policy audit_log_select_scoped on public.audit_log using (private.audit_log_visible(project_id, entity_type, entity_id, old_data, new_data));
    else
        create policy audit_log_select_scoped on public.audit_log for select to authenticated using (private.audit_log_visible(project_id, entity_type, entity_id, old_data, new_data));
    end if;
end
$policies$;

-- Final assertions prevent a silent permissive-policy regression.
do $assert$
begin
    if not exists (select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_select_related' and qual like '%private.can_view_profile%') then raise exception 'Phase B abort: profiles policy is not scoped'; end if;
    if not exists (select 1 from pg_policies where schemaname='public' and tablename='audit_log' and policyname='audit_log_select_scoped' and qual like '%private.audit_log_visible%') then raise exception 'Phase B abort: audit policy is not scoped'; end if;
end
$assert$;
