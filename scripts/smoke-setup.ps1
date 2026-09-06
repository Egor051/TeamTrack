# Local smoke setup: (re)create password users A/B/C via GoTrue admin API.
$ErrorActionPreference = 'Stop'
$container = docker ps --filter name=supabase_db_ --format '{{.Names}}' | Select-Object -First 1
docker exec $container psql -U postgres -d postgres -c "delete from auth.identities where user_id in (select id from auth.users where email in ('a@tt.local','b@tt.local','c@tt.local'))"
docker exec $container psql -U postgres -d postgres -c "delete from auth.users where email in ('a@tt.local','b@tt.local','c@tt.local')"
docker exec $container psql -U postgres -d postgres -c "delete from public.profiles where email in ('a@tt.local','b@tt.local','c@tt.local')"

$status = npx --yes supabase@2.116.0 status -o env | Out-String
$sr = [regex]::Match($status, 'SERVICE_ROLE_KEY="?([^"\r\n]+)').Groups[1].Value
$anon = [regex]::Match($status, 'ANON_KEY="?([^"\r\n]+)').Groups[1].Value

$headers = @{ apikey = $sr; Authorization = "Bearer $sr"; 'Content-Type' = 'application/json' }
foreach ($u in @(@('a@tt.local', 'Alice'), @('b@tt.local', 'Bob'), @('c@tt.local', 'Carol'))) {
  $body = @{ email = $u[0]; password = 'Passw0rd!123'; email_confirm = $true; user_metadata = @{ display_name = $u[1] } } | ConvertTo-Json -Depth 5
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:54321/auth/v1/admin/users' -Method Post -Headers $headers -Body $body -UseBasicParsing
  $created = $r.Content | ConvertFrom-Json
  Write-Host "created $($created.email) $($created.id)"
}

$tokenHeaders = @{ apikey = $anon; 'Content-Type' = 'application/json' }
$r = Invoke-WebRequest -Uri 'http://127.0.0.1:54321/auth/v1/token?grant_type=password' -Method Post -Headers $tokenHeaders -Body '{"email":"a@tt.local","password":"Passw0rd!123"}' -UseBasicParsing
Write-Host "login ok: $((($r.Content | ConvertFrom-Json).user.email))"
