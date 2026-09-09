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
do $$ begin
  if not exists (select 1 from public.tasks where id = :'task' and title='Renamed task' and description='Updated description') then raise exception 'FAIL task edit'; end if;
  if not exists (select 1 from public.task_items where id = :'item' and comment='A useful note' and percentage=50 and not is_completed) then raise exception 'FAIL comment/percentage'; end if;
end $$;

select public.create_task_template('Release template','Release checklist') \gset
\set template :create_task_template
select public.create_task_template_item(:'template','Check build');
select public.create_task_template_item(:'template','Run smoke test');
select public.create_task_from_template(:'project', :'template', 'Release task', 'Copied description') \gset
\set copied_task :create_task_from_template
do $$ declare n int; begin
  select count(*) into n from public.task_items where task_id=:'copied_task';
  if n <> 2 then raise exception 'FAIL template item copy'; end if;
  if exists (select 1 from public.task_items where task_id=:'copied_task' and percentage <> 0) then raise exception 'FAIL template initial percentage'; end if;
end $$;

rollback;
raise notice 'PASS task enhancements';
