-- Global PUBLIC EXECUTE is a built-in PostgreSQL default. Per-schema REVOKE
-- cannot remove it. Only application creator postgres is changed; existing
-- provider functions/ACLs and other creator roles are untouched.
begin;
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon,authenticated,service_role;
alter default privileges for role postgres in schema private
  revoke execute on functions from public,anon,authenticated,service_role;
alter default privileges for role postgres in schema public
  revoke all on tables from public,anon,authenticated,service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from public,anon,authenticated,service_role;
alter default privileges for role postgres in schema private
  revoke all on tables from public,anon,authenticated,service_role;
alter default privileges for role postgres in schema private
  revoke all on sequences from public,anon,authenticated,service_role;
commit;
