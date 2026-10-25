begin read only;
set local search_path=public,extensions;
set local statement_timeout='20s';
do $verify$
begin
 if to_regprocedure('private.configure_client_operation_release(jsonb,jsonb)') is null
  or to_regprocedure('private.set_release_maintenance(boolean)') is null then raise exception 'Release helpers missing'; end if;
 if (select maintenance from private.release_write_control where singleton) is distinct from true then raise exception 'Postconditions require maintenance=true'; end if;
 perform private.assert_release_policies();
 if (select count(*) from private.mutation_entry_inventory)<52 then raise exception 'Mutation inventory incomplete'; end if;
 if exists(select 1 from private.mutation_entry_inventory i where i.name<>'set_task_item_progress'
  and position('private.require_mutation_entry()' in pg_get_functiondef(i.signature::regprocedure))=0) then raise exception 'Mutation guard missing'; end if;
 if has_table_privilege('authenticated','private.release_write_control','SELECT,INSERT,UPDATE,DELETE')
  or has_function_privilege('authenticated','private.configure_client_operation_release(jsonb,jsonb)','EXECUTE')
  or has_function_privilege('service_role','private.set_release_maintenance(boolean)','EXECUTE') then raise exception 'Release control exposed'; end if;
 if to_regclass('cron.job') is null then raise exception 'pg_cron required before opening release'; end if;
 if not exists(select 1 from cron.job where jobname='tasktrace-operation-lifecycle' and active and schedule='*/5 * * * *'
  and username='postgres' and database=current_database() and command='set statement_timeout=''20s''; select private.run_client_operation_lifecycle(500)') then raise exception 'Lifecycle cron configuration differs'; end if;
 if exists(select 1 from (select count(*) n,coalesce(sum(accounted_bytes),0) bytes from private.client_operation_receipts_v3) r
  left join private.client_operation_live_budgets b on b.scope='global'
  where coalesce(b.receipt_count,0)<>r.n or coalesce(b.logical_bytes,0)<>r.bytes) then raise exception 'Live global accounting differs'; end if;
end $verify$;
rollback;
