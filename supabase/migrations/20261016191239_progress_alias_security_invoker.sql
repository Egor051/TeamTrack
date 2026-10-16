-- Keep the hosted compatibility endpoint and named arguments. authenticated
-- already has EXECUTE on the canonical SECURITY DEFINER function it delegates to.
begin;
create or replace function public.set_task_item_progress(
 p_task_item_id uuid,p_completion_percent integer
) returns integer language sql security invoker set search_path='' as $function$
 select public.set_task_item_percentage(p_task_item_id,p_completion_percent);
$function$;
revoke all on function public.set_task_item_progress(uuid,integer) from public,anon,service_role;
grant execute on function public.set_task_item_progress(uuid,integer) to authenticated;
commit;
