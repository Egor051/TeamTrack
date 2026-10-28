import postgres from 'npm:postgres@3.4.9';
import { clientErrorHandler, type IngestResult } from '../_shared/client-error-handler.ts';
import { clientErrorDatabaseOptions } from '../_shared/client-error-db-options.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const key = Deno.env.get('SUPABASE_ANON_KEY')!;
// Managed server secret or an explicitly configured transaction-pooler URL.
// This file is excluded from the app build. No DB credential enters the client.
const connection = Deno.env.get('CLIENT_ERROR_DB_URL') ?? Deno.env.get('SUPABASE_DB_URL');
const sql = postgres(connection!, clientErrorDatabaseOptions(connection, Deno.env.get('CLIENT_ERROR_DB_CA')));
const allowedOrigins = new Set((Deno.env.get('CLIENT_ERROR_ALLOWED_ORIGINS') ?? 'https://tasktrace.ru').split(',').map(s => s.trim()).filter(Boolean));

Deno.serve({ hostname: Deno.env.get('CLIENT_ERROR_HOST') ?? '0.0.0.0', port: Number(Deno.env.get('PORT') ?? '8000') }, clientErrorHandler({
  allowedOrigins,
  authenticate: async (token, signal) => {
    const response = await fetch(`${url}/auth/v1/user`, { signal, headers: { apikey: key, Authorization: `Bearer ${token}` } });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error('Auth unavailable');
    const user = await response.json();
    return typeof user.id === 'string' && /^[a-f\d-]{36}$/i.test(user.id) ? user.id : null;
  },
  ingest: async (userId, event, signal) => {
    const query = sql<{ result: IngestResult }[]>`select private.ingest_client_error(${userId}::uuid,${sql.json(event)}::jsonb) as result`;
    const cancel = () => { try { query.cancel(); } catch { /* Bounded diagnostic request already ended. */ } };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try { return (await query)[0].result; }
    finally { signal.removeEventListener('abort', cancel); }
  },
}));
