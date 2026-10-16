-- Keep function OIDs, bodies, EXECUTE and every trigger attachment unchanged.
begin;
alter function public.prevent_history_mutation() set search_path=pg_catalog,pg_temp;
alter function public.set_updated_at() set search_path=pg_catalog,pg_temp;
commit;
