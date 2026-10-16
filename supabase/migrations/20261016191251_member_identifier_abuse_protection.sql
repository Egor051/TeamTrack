-- Denied identifier lookups must consume quota even when no membership is
-- inserted. A SQL exception rolls the quota back, so business denials return
-- an ordinary PostgREST error envelope with response.status instead of RAISE.
-- Named arguments and HTTP success/error behavior are preserved. SQL callers
-- must inspect the JSON result; PERFORM cannot observe a business denial.
begin;
set local lock_timeout='3s';

create table if not exists private.member_identifier_limits(
 user_id uuid primary key references auth.users(id) on delete cascade,
 window_start timestamptz not null,
 attempts integer not null check(attempts between 1 and 21)
);
alter table private.member_identifier_limits enable row level security;
revoke all on private.member_identifier_limits from public,anon,authenticated,service_role;

-- No DROP CASCADE: unexpected SQL dependencies must block deployment for review.
drop function public.add_project_member_by_identifier(uuid,text,public.project_role);
create function public.add_project_member_by_identifier(
 p_project_id uuid,p_identifier text,p_role public.project_role
) returns jsonb language plpgsql security definer set search_path='' as $function$
declare
 v_actor uuid := private.require_auth();
 v_project public.projects%rowtype;
 v_actor_role public.project_role;
 v_identifier text := pg_catalog.btrim(coalesce(p_identifier,''));
 v_target uuid;
 v_count integer;
 v_window timestamptz;
 v_attempts integer;
 v_error jsonb := pg_catalog.jsonb_build_object('code','TT_MEMBER_LOOKUP',
   'message','Не удалось добавить участника по указанному идентификатору.',
   'details',null,'hint',null);
begin
 -- Invalid arguments cannot be used as an existence oracle.
 if p_project_id is null or p_role is null or p_role='owner'
    or pg_catalog.char_length(v_identifier) not between 1 and 320 then
   raise exception 'invalid member identifier or role' using errcode='22023';
 end if;
 v_project := private.lock_project_state(p_project_id);
 v_actor_role := private.lock_project_role(p_project_id,v_actor);
 if v_actor_role is null or v_actor_role not in ('owner','admin') then
   raise exception 'only owner/admin can manage project members' using errcode='42501';
 end if;
 if p_role='admin' and v_actor_role<>'owner' then
   raise exception 'only the owner can add an admin' using errcode='42501';
 end if;
 if v_project.status<>'active' then raise exception 'project is archived'; end if;

 -- One bucket per actor across ALL projects, including failed lookups.
 -- ON CONFLICT acquires a row lock: parallel requests cannot overspend quota.
 v_window := pg_catalog.date_trunc('minute',pg_catalog.clock_timestamp());
 insert into private.member_identifier_limits as quota(user_id,window_start,attempts)
 values(v_actor,v_window,1)
 on conflict(user_id) do update set window_start=excluded.window_start,
   attempts=case when quota.window_start=excluded.window_start
      then least(quota.attempts+1,21) else 1 end
 returning attempts into v_attempts;
 if v_attempts>20 then
   perform pg_catalog.set_config('response.status','429',true);
   perform pg_catalog.set_config('response.headers',
     pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('Retry-After',
       greatest(1,ceil(extract(epoch from v_window+interval '1 minute'-pg_catalog.clock_timestamp())))::text))::text,true);
   return pg_catalog.jsonb_build_object('code','PT429',
     'message','Слишком много попыток добавления участников. Повторите через минуту.',
     'details',null,'hint',null);
 end if;

 select count(*),(array_agg(id order by id))[1] into v_count,v_target
   from auth.users where email=pg_catalog.lower(v_identifier);
 if v_count=0 then
   select count(*),(array_agg(id order by id))[1] into v_count,v_target
     from public.profiles where display_name=v_identifier;
 end if;
 -- No externally distinct not-found/ambiguous/already-member outcomes.
 if v_count<>1 or v_target is null or exists(
   select 1 from public.project_members where project_id=p_project_id and user_id=v_target
 ) then
   perform pg_catalog.set_config('response.status','400',true);
   return v_error;
 end if;

 insert into public.project_members(project_id,user_id,role) values(p_project_id,v_target,p_role);
 insert into public.task_members(task_id,user_id,set_by,set_at,role_override)
 select t.id,v_target,v_actor,pg_catalog.now(),null from public.tasks t where t.project_id=p_project_id
 on conflict(task_id,user_id) do nothing;
 insert into public.audit_log(project_id,user_id,action,entity_type,entity_id,new_data)
 values(p_project_id,v_actor,'member_added','project_member',v_target,
   pg_catalog.jsonb_build_object('user_id',v_target,'role',p_role));
 return pg_catalog.jsonb_build_object('success',true);
end;
$function$;
revoke all on function public.add_project_member_by_identifier(uuid,text,public.project_role)
 from public,anon,service_role;
grant execute on function public.add_project_member_by_identifier(uuid,text,public.project_role)
 to authenticated;
-- The return type changes from void to JSON; refresh a running API's cache.
notify pgrst, 'reload schema';
commit;
