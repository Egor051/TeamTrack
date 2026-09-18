-- Stage visibility is project-scoped. task_members remains the separate
-- approved-access model used by checklist/history/assignment operations.

drop policy if exists tasks_select_task_member on public.tasks;
drop policy if exists tasks_select_project_member on public.tasks;

create policy tasks_select_project_member
on public.tasks for select
to authenticated
using (private.is_project_member(project_id));

comment on table public.task_members is
    'APPROVED task-scoped access for checklist/history/assignment operations. Stage visibility comes from project_members. Distinct from task_assignees: membership grants task-scoped access, assignment names responsibility.';
