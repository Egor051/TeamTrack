-- Hosted history bridge for 20260901203100.
-- The hosted DDL for this version is already represented by the canonical
-- forward-only migrations in this repository. Replaying it would risk duplicate
-- objects, so this bridge records the remote version without changing schema.
do $$
begin
  if to_regclass('public.task_items') is null then
    raise exception 'Hosted history bridge 20260901203100: base task_items table is missing';
  end if;
end
$$;
