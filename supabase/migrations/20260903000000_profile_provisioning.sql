-- TaskTrace — profile provisioning trigger (migration 0003)
-- Requires:
--   20260901000000_initial_schema.sql  (public.profiles table)
--   20260902000000_rls_authorization.sql (private.handle_new_user function)
--
-- Activates automatic profile creation when a new row is inserted into
-- auth.users (i.e. on Supabase Auth sign-up). The function
-- private.handle_new_user() already exists in migration 0002; this migration
-- simply creates the trigger that was intentionally deferred during the
-- baseline smoke tests.
--
-- The function reads raw_user_meta_data->>'display_name' first, then
-- raw_user_meta_data->>'name', and finally falls back to the email prefix.

-- Idempotency: drop the trigger first if it somehow already exists.
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
    after insert on auth.users
    for each row
    execute function private.handle_new_user();

-- Also handle UPDATE on auth.users for cases where metadata is updated
-- after initial signup (e.g. display_name was missing and added later).
-- on conflict (id) do nothing inside handle_new_user makes this safe.
drop trigger if exists on_auth_user_updated on auth.users;

create trigger on_auth_user_updated
    after update on auth.users
    for each row
    when (old.raw_user_meta_data is distinct from new.raw_user_meta_data)
    execute function private.handle_new_user();
