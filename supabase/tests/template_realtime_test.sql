\set ON_ERROR_STOP on
begin;
insert into auth.users(id,email,aud,role,raw_app_meta_data,raw_user_meta_data,email_confirmed_at,created_at,updated_at,is_anonymous,is_sso_user)
select ('73000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'template-realtime-'||n||'@test.local',
  'authenticated','authenticated','{}','{}',now(),now(),now(),false,false from generate_series(1,2) n;
create temp table template_realtime_state(key text primary key,id uuid);
grant all on template_realtime_state to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','73000000-0000-4000-8000-000000000001',true);
do $$begin
  if not private.can_receive_realtime_topic('templates') or private.can_receive_realtime_topic('templates:other')
    or private.can_receive_realtime_topic('templates:') then raise exception 'library scope validation failed'; end if;
end $$;
insert into template_realtime_state values('template', public.create_task_template('Global library secret marker','Not in Broadcast'));
insert into template_realtime_state values('item',public.create_task_template_item((select id from template_realtime_state where key='template'),'Private payload marker','Not in Broadcast'));
select public.update_task_template((select id from template_realtime_state where key='template'),'Changed library marker','Changed');
select public.update_task_template_item((select id from template_realtime_state where key='item'),'Changed item marker','Changed');
select public.delete_task_template_item((select id from template_realtime_state where key='item'));
-- Global read access does not grant edit rights, even to a project/stage admin.
select set_config('request.jwt.claim.sub','73000000-0000-4000-8000-000000000002',true);
do $$declare v_id uuid := (select id from template_realtime_state where key='template'); begin
  if not private.can_receive_realtime_topic('templates') or public.get_task_template(v_id) is null then
    raise exception 'authenticated global library is inaccessible'; end if;
  begin perform public.update_task_template(v_id,'Denied',''); raise exception 'foreign template write accepted';
    exception when insufficient_privilege then null; end;
  begin perform public.create_task_template_item(v_id,'Denied'); raise exception 'foreign item write accepted';
    exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','73000000-0000-4000-8000-000000000001',true);
select public.archive_task_template((select id from template_realtime_state where key='template'));
select set_config('request.jwt.claim.sub','73000000-0000-4000-8000-000000000002',true);
do $$declare v_id uuid := (select id from template_realtime_state where key='template'); begin
  if public.get_task_template(v_id) is not null
    or exists(select 1 from public.list_task_templates() where id=v_id)
    or exists(select 1 from public.list_task_template_items(v_id)) then raise exception 'archived content leaked'; end if;
end $$;
reset role;
do $$declare v_payload jsonb; begin
  if (select count(*) from realtime.messages where topic='templates') <> 6 then raise exception 'missing/duplicate template signals'; end if;
  for v_payload in select payload from realtime.messages where topic='templates' loop
    -- realtime.send adds its own message UUID; it is not a template/item ID.
    if (select count(*) from jsonb_object_keys(v_payload - 'id')) <> 2 or not v_payload ? 'table' or not v_payload ? 'operation'
      or v_payload->>'table' not in ('task_templates','task_template_items') then raise exception 'Broadcast leaked row data: %',v_payload; end if;
    if exists(select 1 from template_realtime_state where id::text=v_payload->>'id') then raise exception 'row identity leaked'; end if;
  end loop;
  if exists(select 1 from realtime.messages where topic='templates' and (not private or event<>'invalidate')) then raise exception 'non-private library signal'; end if;
  if has_function_privilege('authenticated','private.broadcast_application_invalidation()','execute')
    or has_function_privilege('anon','private.can_receive_realtime_topic(text)','execute') then raise exception 'trigger/topic grants widened'; end if;
end $$;
-- A multi-row insert/update/delete emits one event per statement, not per item.
insert into public.task_template_items(template_id,title,position)
select (select id from template_realtime_state where key='template'),'Bulk '||n,n from generate_series(1,1001) n;
update public.task_template_items set position=position+10000 where template_id=(select id from template_realtime_state where key='template');
delete from public.task_template_items where template_id=(select id from template_realtime_state where key='template');
do $$begin
  if (select count(*) from realtime.messages where topic='templates') <> 9 then raise exception 'bulk events not coalesced'; end if;
end $$;
select set_config('request.jwt.claim.sub','',true);
do $$begin if private.can_receive_realtime_topic('templates') then raise exception 'unauthenticated scope accepted'; end if; end $$;
set local role anon;
do $$begin
  begin
    if exists(select 1 from realtime.messages where topic='templates') then raise exception 'anonymous Broadcast read'; end if;
  exception when insufficient_privilege then null; end;
  begin perform public.get_task_template_page(null,0,500,null); raise exception 'anonymous template page accepted';
    exception when insufficient_privilege then null; end;
end $$;
rollback;
