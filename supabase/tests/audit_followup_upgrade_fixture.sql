-- Applied only to the disposable upgrade database before the followup migration.
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('74000000-0000-4000-8000-000000000001','followup-upgrade-owner@test.local','{}'),
 ('74000000-0000-4000-8000-000000000002','followup-upgrade-member@test.local','{}');
create table public.followup_upgrade_ids(item_id uuid,task_id uuid,project_id uuid);
set local role authenticated;
select set_config('request.jwt.claim.sub','74000000-0000-4000-8000-000000000001',true);
select public.create_project('Legacy followup history') legacy_project \gset
select public.add_project_member(:'legacy_project','74000000-0000-4000-8000-000000000002','member');
select public.create_task(:'legacy_project','Legacy stage') legacy_task \gset
select public.create_task_item(:'legacy_task','Legacy item') legacy_item \gset
select public.set_task_item_comment(:'legacy_item','Legacy immutable comment');
select public.set_task_item_percentage(:'legacy_item',65);
select public.archive_task_item(:'legacy_item');
select public.hard_delete_task_item(:'legacy_item');
reset role;
insert into public.followup_upgrade_ids values(:'legacy_item',:'legacy_task',:'legacy_project');
commit;
