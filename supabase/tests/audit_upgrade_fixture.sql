-- Run immediately before backend remediation, under the old constraints.
insert into auth.users(id, email, raw_user_meta_data)
values ('00000000-0000-4000-a000-000000000991', 'legacy-upgrade@example.test', '{"display_name":"A"}');
update public.profiles set display_name = 'A' where id = '00000000-0000-4000-a000-000000000991';
insert into public.projects(id, name, description, created_by)
values ('00000000-0000-4000-a000-000000000992', repeat('L', 501), repeat('D', 10001), '00000000-0000-4000-a000-000000000991');
insert into public.project_members(project_id, user_id, role)
values ('00000000-0000-4000-a000-000000000992', '00000000-0000-4000-a000-000000000991', 'owner');
insert into public.tasks(id, project_id, title, description, created_by)
values ('00000000-0000-4000-a000-000000000993', '00000000-0000-4000-a000-000000000992', repeat('T', 501), repeat('D', 10001), '00000000-0000-4000-a000-000000000991');
insert into public.task_items(id, task_id, title, description, position)
values ('00000000-0000-4000-a000-000000000994', '00000000-0000-4000-a000-000000000993', repeat('I', 501), repeat('D', 10001), 1);
insert into public.audit_log(user_id, project_id, action, entity_type, entity_id, new_data)
values ('00000000-0000-4000-a000-000000000991', '00000000-0000-4000-a000-000000000992', 'created', 'task', '00000000-0000-4000-a000-000000000993', '{"legacy":true}');
