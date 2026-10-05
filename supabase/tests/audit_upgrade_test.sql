begin;
do $$
begin
  if (select display_name from public.profiles where id = '00000000-0000-4000-a000-000000000991') <> 'A' then
    raise exception 'AUD-03: legacy display name was lost';
  end if;
  if not exists (select 1 from public.projects where id = '00000000-0000-4000-a000-000000000992' and length(name) = 501 and length(description) = 10001)
     or not exists (select 1 from public.tasks where id = '00000000-0000-4000-a000-000000000993' and length(title) = 501)
     or not exists (select 1 from public.task_items where id = '00000000-0000-4000-a000-000000000994' and length(title) = 501)
     or not exists (select 1 from public.audit_log where new_data = '{"legacy":true}'::jsonb) then
    raise exception 'AUD-03: legacy rows/history were lost';
  end if;
  begin
    update public.profiles set display_name = 'B' where id = '00000000-0000-4000-a000-000000000991';
    raise exception 'AUD-03: new invalid profile write accepted';
  exception when check_violation then null; end;
  begin
    insert into public.projects(name, created_by) values (repeat('N', 501), '00000000-0000-4000-a000-000000000991');
    raise exception 'AUD-03: new overlong project write accepted';
  exception when check_violation then null; end;
  raise notice 'PASS AUD-03 legacy rows preserved; new writes still enforce text checks';
end $$;
rollback;
