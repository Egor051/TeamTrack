-- These roles use RLS SELECT and RPC, never table DDL/maintenance. Trigger
-- execution depends on its server function and attachment, not caller TRIGGER.
begin;
revoke references,trigger,maintain on table
 public.profiles,public.projects,public.tasks,public.audit_log,public.item_actions,
 public.task_items,public.project_members,public.task_assignees,public.task_members
from authenticated;
commit;
