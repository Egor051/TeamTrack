-- Hosted history bridge for 20260909221947.
-- The hosted hard-delete/history reconciliation is applied after the local
-- authorization and lifecycle helpers; this marker preserves the remote
-- version without replaying foreign-key DDL in the wrong local order.
do $$
begin
  if to_regclass('public.task_items') is null then
    raise exception 'Hosted history bridge 20260909221947: base task_items table is missing';
  end if;
end
$$;
