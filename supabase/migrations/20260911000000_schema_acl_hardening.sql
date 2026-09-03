-- Do not let API roles create shadow objects in exposed schemas. All app
-- tables/functions are created by migrations and receive explicit grants.
revoke create on schema public from public, anon, authenticated;

-- Keep future objects closed by default. Individual migrations must grant only
-- the operations needed by the client or server-side RPCs.
alter default privileges for role postgres in schema public
    revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
    revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
    revoke execute on functions from public, anon, authenticated;
