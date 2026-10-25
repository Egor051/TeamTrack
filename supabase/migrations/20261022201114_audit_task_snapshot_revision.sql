begin;
set local lock_timeout='5s';
-- Relation lock precedes the feed lock, matching DML's relation/statement order.
lock table public.task_items in share row exclusive mode;
select pg_catalog.pg_advisory_xact_lock(29175,5);
create table private.task_item_snapshot_revisions (
  task_id uuid primary key references public.tasks(id) on delete cascade,
  revision bigint not null check(revision>=0)
);
alter table private.task_item_snapshot_revisions enable row level security;
revoke all on private.task_item_snapshot_revisions from public,anon,authenticated,service_role;
insert into private.task_item_snapshot_revisions
select t.id,coalesce(max(c.cursor),0) from public.tasks t
left join private.task_item_sync_changes c on c.task_id=t.id group by t.id;

create or replace function private.record_task_item_sync_change()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_item public.task_items%rowtype; v_project uuid; v_cursor bigint;
begin
  if tg_op='UPDATE' and (to_jsonb(new)-'updated_at') is not distinct from (to_jsonb(old)-'updated_at') then return new; end if;
  if tg_op='DELETE' then v_item:=old; else v_item:=new; end if;
  select project_id into v_project from public.tasks where id=v_item.task_id;
  if v_project is null then return null; end if;
  insert into private.task_item_sync_changes(project_id,task_id,task_item_id,change_type,item)
  values(v_project,v_item.task_id,v_item.id,case when tg_op='DELETE' then 'delete' else 'upsert' end,
    case when tg_op='DELETE' then null else to_jsonb(new) end) returning cursor into v_cursor;
  insert into private.task_item_snapshot_revisions as r values(v_item.task_id,v_cursor)
    on conflict(task_id) do update set revision=greatest(r.revision,excluded.revision);
  if tg_op='UPDATE' and old.task_id<>new.task_id then
    insert into private.task_item_snapshot_revisions as r values(old.task_id,v_cursor)
      on conflict(task_id) do update set revision=greatest(r.revision,excluded.revision);
  end if;
  return null;
end $$;

create or replace function public.get_task_item_snapshot_page(p_task_id uuid,p_mode text default 'all',
  p_offset integer default 0,p_limit integer default 500,p_revision bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=private.require_auth(); v_revision bigint; v_total bigint; v_rows jsonb;
begin
  if p_mode is null or p_mode not in ('all','active','archived') or p_offset is null or p_offset<0
    or p_limit is null or p_limit not between 1 and 500 then raise exception 'invalid snapshot page' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(29175,5);
  if not private.has_task_access(p_task_id,v_user) then raise exception 'no access to task' using errcode='42501'; end if;
  select coalesce((select revision from private.task_item_snapshot_revisions where task_id=p_task_id),0) into v_revision;
  if p_revision is not null and p_revision<>v_revision then raise exception 'Snapshot changed between pages' using errcode='PT409'; end if;
  select count(*) into v_total from public.task_items i where i.task_id=p_task_id and (p_mode='all' or i.is_archived=(p_mode='archived'));
  select coalesce(jsonb_agg(to_jsonb(page) order by page.position,page.id),'[]') into v_rows
    from(select i.* from public.task_items i where i.task_id=p_task_id and (p_mode='all' or i.is_archived=(p_mode='archived'))
      order by i.position,i.id limit p_limit offset p_offset) page;
  return jsonb_build_object('revision',v_revision,'total',v_total,'offset',p_offset,'rows',v_rows);
end $$;
revoke all on function public.get_task_item_snapshot_page(uuid,text,integer,integer,bigint) from public,anon,service_role;
grant execute on function public.get_task_item_snapshot_page(uuid,text,integer,integer,bigint) to authenticated;
notify pgrst,'reload schema';
commit;
