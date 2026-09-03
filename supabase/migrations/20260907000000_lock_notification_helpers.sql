-- Notification helpers are internal trigger plumbing, never client-callable.
revoke all on function private.create_notification(uuid, uuid, uuid, public.notification_type, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function private.audit_to_notification()
  from public, anon, authenticated;
