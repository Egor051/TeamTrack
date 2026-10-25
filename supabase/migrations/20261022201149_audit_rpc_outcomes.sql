begin;
set local lock_timeout='5s';
create or replace function public.execute_client_mutation(p_operation_id uuid,p_name text,p_args jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=private.require_auth(); v_claimed boolean; v_saved jsonb; v_proc oid;
  v_arguments text; v_result jsonb; v_status integer; v_retry text; v_until timestamptz;
begin
  if p_name is null or p_name<>all(array['create_project','update_project','archive_project','restore_project','hard_delete_project',
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
  if not v_claimed then
    v_result:=v_saved->'value';
    v_status:=coalesce((v_saved->>'http_status')::integer,200);
    if v_saved->>'format_version' is null and p_name in ('add_project_member_by_identifier','add_task_member_by_identifier') then
      if v_result->>'code'='TT_MEMBER_LOOKUP' then v_status:=400;
      elsif v_result->>'code'='PT429' then v_status:=429; end if;
    end if;
    perform set_config('response.status',v_status::text,true);
    if v_saved->>'retry_after_until' is not null then
      perform set_config('response.headers',jsonb_build_array(jsonb_build_object('Retry-After',
        greatest(0,ceil(extract(epoch from (v_saved->>'retry_after_until')::timestamptz-clock_timestamp())))::text))::text,true);
    end if;
    return v_result;
  end if;
  select string_agg(format('%I => ($1->>%L)::%s',p.proargnames[s],p.proargnames[s],format_type(p.proargtypes[s-1],null)),',' order by s)
    into v_arguments from pg_proc p cross join generate_series(1,p.pronargs) s where p.oid=v_proc and p_args?p.proargnames[s];
  perform set_config('response.status','200',true);
  perform set_config('response.headers','[]',true);
  execute format('select to_jsonb(public.%I(%s))',p_name,coalesce(v_arguments,'')) into v_result using p_args;
  v_status:=coalesce(nullif(current_setting('response.status',true),''),'200')::integer;
  select h->>'Retry-After' into v_retry from jsonb_array_elements(coalesce(nullif(current_setting('response.headers',true),''),'[]')::jsonb) h
    where h?'Retry-After' limit 1;
  if v_retry~'^\d+$' then v_until:=clock_timestamp()+v_retry::integer*interval '1 second'; end if;
  update private.client_operation_receipts set result_payload=jsonb_build_object('format_version',2,'value',v_result,
    'http_status',v_status,'retry_after_until',v_until),completed_at=clock_timestamp()
    where user_id=v_user and operation_id=p_operation_id;
  return v_result;
end $$;
revoke all on function public.execute_client_mutation(uuid,text,jsonb) from public,anon,service_role;
grant execute on function public.execute_client_mutation(uuid,text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
