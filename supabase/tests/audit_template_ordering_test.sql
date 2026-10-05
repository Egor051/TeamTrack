begin;
do $$
begin
  if (select array_agg(position order by position, created_at, id) from public.task_template_items where template_id = '00000000-0000-4000-a000-000000000995') <> array[1,2,3,4]::numeric[] then
    raise exception 'AUD-06 UPGRADE: legal legacy duplicates were not normalized';
  end if;
  if (select array_agg(title order by position) from public.task_template_items where template_id = '00000000-0000-4000-a000-000000000995') <> array['Legacy A','Legacy B','Legacy C','Legacy D']
     or (select count(*) from public.task_template_items where template_id = '00000000-0000-4000-a000-000000000995' and description like 'Preserve %') <> 4 then
    raise exception 'AUD-06 UPGRADE: legacy order/content was lost';
  end if;
end $$;
create temp table audit_order_state(key text primary key, id uuid);
grant all on audit_order_state to authenticated;
insert into auth.users(id, email, raw_user_meta_data) values ('00000000-0000-4000-a000-000000000901', 'audit-order@example.test', '{"display_name":"Audit Owner"}'),
 ('00000000-0000-4000-a000-000000000902', 'audit-other@example.test', '{"display_name":"Audit Other"}');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-a000-000000000901', true);
insert into audit_order_state select 'project', public.create_project('Audit ordering');
insert into audit_order_state select 'template', public.create_task_template('Audit ordering');
insert into audit_order_state select 'a', public.create_task_template_item((select id from audit_order_state where key='template'), 'A');
insert into audit_order_state select 'b', public.create_task_template_item((select id from audit_order_state where key='template'), 'B');
insert into audit_order_state select 'c', public.create_task_template_item((select id from audit_order_state where key='template'), 'C');
select public.move_task_template_item((select id from audit_order_state where key='b'), -1);
select public.move_task_template_item((select id from audit_order_state where key='a'), -1);
select public.move_task_template_item((select id from audit_order_state where key='c'), -1);
select public.update_task_template_item((select id from audit_order_state where key='c'), 'NEW', 'independently saved');
select public.move_task_template_item((select id from audit_order_state where key='c'), -1);
insert into audit_order_state select 'd', public.create_task_template_item((select id from audit_order_state where key='template'), 'D');
insert into audit_order_state select 'copied', public.create_task_from_template((select id from audit_order_state where key='project'), (select id from audit_order_state where key='template'));
-- The template numeric type remains more precise/wider than task_items.
-- Even legal positions introduced after the upgrade must copy without
-- rounding collisions or overflow.
insert into audit_order_state select 'precise-template', public.create_task_template('Precise ordering');
select public.create_task_template_item((select id from audit_order_state where key='precise-template'), 'Precise A', null, 0.12345678901234561);
select public.create_task_template_item((select id from audit_order_state where key='precise-template'), 'Precise B', null, 0.12345678901234562);
select public.create_task_template_item((select id from audit_order_state where key='precise-template'), 'Huge C', null, 1e40);
insert into audit_order_state select 'precise-copy', public.create_task_from_template((select id from audit_order_state where key='project'), (select id from audit_order_state where key='precise-template'));
do $$
begin
  begin
    perform public.create_task_template_item((select id from audit_order_state where key='precise-template'), 'Infinite', null, 'Infinity'::numeric);
    raise exception 'AUD-06: infinite position accepted';
  exception when check_violation then null; end;
end $$;
reset role;
do $$
declare v_template uuid := (select id from audit_order_state where key='template');
begin
  if (select array_agg(title order by position) from public.task_template_items where template_id=v_template) <> array['NEW','A','B','D'] then raise exception 'AUD-05/06/07: move/add changed content or order'; end if;
  if (select count(distinct position) from public.task_template_items where template_id=v_template) <> 4 then raise exception 'AUD-06: duplicate positions'; end if;
  if (select array_agg(position order by position) from public.task_items where task_id=(select id from audit_order_state where key='copied')) <> array[1,2,3,4]::numeric[] then raise exception 'AUD-06: copied positions are invalid'; end if;
  if (select array_agg(position order by position) from public.task_items where task_id=(select id from audit_order_state where key='precise-copy')) <> array[1,2,3]::numeric[]
    or (select array_agg(title order by position) from public.task_items where task_id=(select id from audit_order_state where key='precise-copy')) <> array['Precise A','Precise B','Huge C'] then
    raise exception 'AUD-06: copying legal precise/large positions changed order or lost uniqueness';
  end if;
  if (select description from public.task_template_items where id=(select id from audit_order_state where key='c')) <> 'independently saved' then raise exception 'AUD-07: reorder overwrote description'; end if;
  begin
    update public.task_template_items set position=1 where id=(select id from audit_order_state where key='d');
    raise exception 'AUD-06: duplicate position accepted';
  exception when unique_violation then null; end;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-a000-000000000902', true);
do $$
begin
  begin
    perform public.move_task_template_item((select id from audit_order_state where key='a'), -1);
    raise exception 'AUD-07: another user moved an owned item';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
