const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const SUPABASE_POOLER_HOST = /\.pooler\.supabase\.com$/i;
const SUPABASE_DIRECT_HOST = /^db\.[a-z0-9-]+\.supabase\.co$/i;

export function classifyDatabaseUrl(value) {
  if (!value || !value.trim()) return { kind: 'empty' };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { kind: 'invalid' };
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return { kind: 'invalid' };

  const host = url.hostname.toLowerCase();
  const port = Number(url.port || 5432);
  if (LOOPBACK_HOSTS.has(host)) return { kind: 'local-direct', host, port };
  if (SUPABASE_POOLER_HOST.test(host)) {
    if (port === 5432) return { kind: 'hosted-pooler', mode: 'session', host, port };
    if (port === 6543) return { kind: 'hosted-pooler', mode: 'transaction', host, port };
    return { kind: 'hosted-pooler', mode: 'unknown', host, port };
  }
  if (SUPABASE_DIRECT_HOST.test(host)) {
    if (port === 6543) return { kind: 'hosted-pooler', mode: 'transaction', host, port, dedicated: true };
    return { kind: 'hosted-direct', host, port };
  }
  return { kind: 'other', host, port };
}

export function assertTypeGenerationDatabaseUrl(value, variableName = 'SUPABASE_DB_URL') {
  const classification = classifyDatabaseUrl(value);
  if (classification.kind === 'empty') throw new Error(`${variableName} is not set (see .env.example).`);
  if (classification.kind === 'invalid') throw new Error(`${variableName} must be a PostgreSQL connection string.`);
  if (classification.kind === 'local-direct') return classification;
  if (classification.kind === 'hosted-pooler' && classification.mode === 'session') return classification;
  if (classification.kind === 'hosted-direct') {
    throw new Error(`${variableName} points to the hosted direct Postgres endpoint. Use the Supabase pooler session endpoint on port 5432 (or use --project-id with a linked CLI project).`);
  }
  if (classification.kind === 'hosted-pooler') {
    throw new Error(`${variableName} must use Supavisor session mode on port 5432 for type generation; transaction mode does not provide session semantics required by some CLI/database drivers.`);
  }
  throw new Error(`${variableName} must point to the local database or a Supabase pooler endpoint.`);
}

export function assertNoPublicDatabaseUrl(variableName, value) {
  if (variableName.startsWith('EXPO_PUBLIC_') && /^(postgres|postgresql):\/\//i.test(value.trim())) {
    throw new Error(`${variableName} must never contain a database connection string.`);
  }
}
