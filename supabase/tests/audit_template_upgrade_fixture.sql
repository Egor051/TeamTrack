-- Duplicates, oversized and infinite positions were legal in the old schema.
insert into public.task_templates(id, name, created_by)
values ('00000000-0000-4000-a000-000000000995', 'Legacy duplicate positions', '00000000-0000-4000-a000-000000000991');
insert into public.task_template_items(id, template_id, title, description, position, created_at)
values
 ('00000000-0000-4000-a000-000000000996', '00000000-0000-4000-a000-000000000995', 'Legacy A', 'Preserve A', 0, '2026-09-01'),
 ('00000000-0000-4000-a000-000000000997', '00000000-0000-4000-a000-000000000995', 'Legacy B', 'Preserve B', 0, '2026-09-02'),
 ('00000000-0000-4000-a000-000000000998', '00000000-0000-4000-a000-000000000995', 'Legacy C', 'Preserve C', 1e40, '2026-09-03'),
 ('00000000-0000-4000-a000-000000000999', '00000000-0000-4000-a000-000000000995', 'Legacy D', 'Preserve D', 'Infinity'::numeric, '2026-09-04');
