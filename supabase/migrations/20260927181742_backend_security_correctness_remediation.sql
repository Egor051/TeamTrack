-- Enum additions live in their own migration because PostgreSQL requires a
-- commit boundary before a newly-added enum value can be used by functions.
alter type public.notification_type
    add value if not exists 'task_role_changed';

comment on type public.notification_type is
    'User notification categories, including explicit per-stage checklist role changes.';
