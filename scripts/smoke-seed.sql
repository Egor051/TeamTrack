-- Manual smoke seed: password users A/B/C for local browser testing.
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, email_confirmed_at, created_at, updated_at, is_anonymous, is_sso_user, encrypted_password)
values
  ('11111111-1111-4111-8111-111111111111', 'a@tt.local', 'authenticated', 'authenticated', '{}', jsonb_build_object('display_name','Alice'), now(), now(), now(), false, false, crypt('Passw0rd!123', gen_salt('bf'))),
  ('22222222-2222-4222-8222-222222222222', 'b@tt.local', 'authenticated', 'authenticated', '{}', jsonb_build_object('display_name','Bob'), now(), now(), now(), false, false, crypt('Passw0rd!123', gen_salt('bf'))),
  ('33333333-3333-4333-8333-333333333333', 'c@tt.local', 'authenticated', 'authenticated', '{}', jsonb_build_object('display_name','Carol'), now(), now(), now(), false, false, crypt('Passw0rd!123', gen_salt('bf')))
on conflict (id) do nothing;
