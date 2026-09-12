-- Focused regression checks for task edit, comments, percentage progress, and templates.
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data,
                        email_confirmed_at, created_at, updated_at, is_anonymous, is_sso_user)
values
 ('30000000-0000-0000-0000-000000000001','enh-owner@test.local','authenticated','authenticated','{}','{"display_name":"Enh Owner"}',now(),now(),now(),false,false),
 ('30000000-0000-0000-0000-000000000002','enh-viewer@test.local','authenticated','authenticated','{}','{"display_name":"Enh Viewer"}',now(),now(),now(),false,false)
on conflict (id) do nothing;

set local role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',true);
select public.create_project('Enhancement project','test') \gset
\set project :create_project
select public.create_task(:'project','Original task','Original description') \gset
\set task :create_task
select public.create_task_item(:'task','First item') \gset
\set item :create_task_item

select public.update_task(:'task','Renamed task','Updated description');
select public.set_task_item_comment(:'item','A useful note');
select public.set_task_item_percentage(:'item',50);
select exists (select 1 from public.audit_log where entity_type='task_item' and entity_id=:'item' and action='updated' and new_data @> '{"comment":"A useful note"}'::jsonb) as comment_audit_ok \gset
\if :comment_audit_ok
\else
\echo 'FAIL comment audit'
\quit 1
\endif
select exists (select 1 from public.audit_log where entity_type='task_item' and entity_id=:'item' and action='updated' and new_data->>'percentage'='50') as percentage_audit_ok \gset
\if :percentage_audit_ok
\else
\echo 'FAIL percentage audit'
\quit 1
\endif
select exists (select 1 from public.tasks where id = :'task' and title='Renamed task' and description='Updated description') as task_edit_ok \gset
\if :task_edit_ok
\else
\echo 'FAIL task edit'
\quit 1
\endif
select exists (select 1 from public.task_items where id = :'item' and comment='A useful note' and percentage=50 and not is_completed) as comment_percentage_ok \gset
\if :comment_percentage_ok
\else
\echo 'FAIL comment/percentage'
\quit 1
\endif

-- Creation alone is not an edit: there is no qualifying last editor yet.
select public.create_task_item(:'task','Untouched item') \gset
\set untouched_item :create_task_item
select not exists (
    select 1 from public.list_task_item_last_editors(:'task')
    where task_item_id = :'untouched_item'
) as untouched_editor_empty \gset
\if :untouched_editor_empty
\else
\echo 'FAIL missing editor was synthesized for untouched item'
\quit 1
\endif

-- A later title-only rename must not replace the last non-title editor.
select public.add_project_member(:'project','30000000-0000-0000-0000-000000000002','member');
select public.approve_task_member(:'task','30000000-0000-0000-0000-000000000002');
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000002',true);
select public.update_task_item(:'item','Title-only rename');
select user_id = '30000000-0000-0000-0000-000000000001'::uuid as title_only_editor_excluded
  from public.list_task_item_last_editors(:'task') where task_item_id=:'item' \gset
\if :title_only_editor_excluded
\else
\echo 'FAIL title-only editor exclusion'
\quit 1
\endif
select set_config('request.jwt.claim.sub','30000000-0000-0000-0000-000000000001',true);

select public.create_task_template('Release template','Release checklist') \gset
\set template :create_task_template
select public.create_task_template_item(:'template','Check build');
select public.create_task_template_item(:'template','Run smoke test');
select public.create_task_from_template(:'project', :'template', 'Release task', 'Copied description') \gset
\set copied_task :create_task_from_template
select count(*) = 2 as template_item_copy_ok
from public.task_items where task_id=:'copied_task' \gset
\if :template_item_copy_ok
\else
\echo 'FAIL template item copy'
\quit 1
\endif
select not exists (select 1 from public.task_items where task_id=:'copied_task' and percentage <> 0) as template_percentage_ok \gset
\if :template_percentage_ok
\else
\echo 'FAIL template initial percentage'
\quit 1
\endif

rollback;
\echo 'PASS task enhancements'
