-- User endpoints use authenticated JWTs; cron runs as postgres.
-- No tracked Edge Function/server integration consumes these service grants.
begin;
revoke execute on function public.apply_task_item_comment_operation(uuid,uuid,text),
 public.apply_task_item_comment_operation_v2(uuid,uuid,bigint,text),
 public.apply_task_item_percentage_operation(uuid,uuid,integer),
 public.apply_task_item_percentage_operation_v2(uuid,uuid,bigint,integer),
 public.apply_task_item_state_operation(uuid,uuid,boolean),
 public.apply_task_item_state_operation_v2(uuid,uuid,bigint,boolean),
 public.get_offline_runtime_config(),
 public.get_task_item_sync_cursor(),
 public.move_task_template_item(uuid,integer),
 public.pull_task_item_changes(bigint,integer),
 public.pull_task_item_changes_v2(bigint,integer)
from service_role;
commit;
