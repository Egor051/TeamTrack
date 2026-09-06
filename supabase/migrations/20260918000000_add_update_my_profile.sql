-- Canonical self-service profile update RPC.
--
-- The hosted Supabase project was missing public.update_my_profile(text)
-- (PGRST202: "Could not find the function public.update_my_profile(p_display_name)
-- in the schema cache") because the improve-pass migration that introduces it
-- had never been applied there. This migration carries an independent, safe,
-- canonical definition of the RPC so it can be (re-)applied on its own:
--   * SECURITY DEFINER with a pinned search_path;
--   * only the calling user's own profile row is ever touched (auth.uid() is
--     mandatory — there is no way to target another user's profile);
--   * display_name is validated (2..80 chars after trim, restricted charset);
--   * EXECUTE is granted to authenticated only;
--   * the direct profiles UPDATE grant model is unchanged (RLS
--     profiles_update_self + column-level ACL still apply).
create or replace function public.update_my_profile(p_display_name text)
returns public.profiles
language plpgsql
security definer
set search_path = private, public
as $$
declare
    v_user uuid := private.require_auth();
    v_name text := btrim(coalesce(p_display_name, ''));
    v_profile public.profiles;
begin
    if length(v_name) < 2 or length(v_name) > 80 then
        raise exception 'display name must be between 2 and 80 characters';
    end if;
    if v_name !~ '^[[:alnum:]_ .-]+$' then
        raise exception 'display name contains unsupported characters';
    end if;
    update public.profiles set display_name = v_name where id = v_user returning * into v_profile;
    if not found then raise exception 'profile not found'; end if;
    insert into public.audit_log(project_id, user_id, action, entity_type, entity_id, old_data, new_data)
    values (null, v_user, 'updated', 'profile', v_user,
            jsonb_build_object('display_name', null),
            jsonb_build_object('display_name', v_name));
    return v_profile;
end
$$;

revoke all on function public.update_my_profile(text) from public, anon;
grant execute on function public.update_my_profile(text) to authenticated;
