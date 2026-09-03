-- Profile timestamps and identity are server-managed. Keep self-service
-- editing limited to the fields exposed by the profile UI.
revoke update on public.profiles from authenticated;
grant update (display_name, avatar_url) on public.profiles to authenticated;
