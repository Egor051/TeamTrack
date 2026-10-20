import type { Session } from '@supabase/supabase-js';
import { boundedOperation } from '@/lib/connectivity/deadline';
import { ServiceUnavailableError } from '@/lib/connectivity/errors';
import type { ConnectivityProbeResult } from '@/lib/connectivity/state';

type SessionReader = () => Promise<Pick<Session, 'access_token'> | null>;
export async function probeSupabase(url: string, key: string, readSession: SessionReader, signal?: AbortSignal): Promise<ConnectivityProbeResult> {
  // Reachability must not depend on an SDK refresh/lock. Stored credentials
  // identify a probe only; a 401/403 is handled by normal Auth, never cached.
  const session = await boundedOperation(readSession, 1000, signal).catch((error) => {
    if (signal?.aborted) throw error;
    return null;
  });
  const headers: Record<string, string> = { apikey: key, Accept: 'application/json' };
  let authorizationRequired = false;
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  const check = (path: string, service: 'auth-service' | 'data-service') => boundedOperation(async (requestSignal) => {
    const response = await fetch(`${url}${path}`, {
      headers: service === 'auth-service' ? { apikey: key, Accept: 'application/json' } : headers,
      signal: requestSignal, cache: 'no-store', redirect: 'error',
    });
    // Include body consumption in the deadline: headers alone are insufficient
    // on half-open connections and captive portals often return HTML/200.
    let body: unknown;
    try { body = await response.json(); }
    catch { throw new ServiceUnavailableError(service, response.status); }
    if (service === 'auth-service') {
      if ([401, 403].includes(response.status)) { authorizationRequired = true; return; }
      if (!response.ok || !body || typeof body !== 'object' || !('version' in body) || typeof body.version !== 'string')
        throw new ServiceUnavailableError(service, response.status);
    } else {
      if (response.ok && Array.isArray(body)) return;
      const code = (body as { code?: string } | null)?.code;
      // SQL/business responses and authorization failures prove PostgREST is
      // serving requests. Connection-pool/gateway failures do not.
      if ([401, 403].includes(response.status)) { authorizationRequired = true; return; }
      if ([400, 429].includes(response.status) || (code && /^[A-Z0-9]{5}$/.test(code))) return;
      throw new ServiceUnavailableError(service, response.status);
    }
  }, 5000, signal).catch((error) => {
    if (signal?.aborted || error instanceof ServiceUnavailableError) throw error;
    throw new ServiceUnavailableError(service);
  });
  await check('/auth/v1/health', 'auth-service');
  await check('/rest/v1/projects?select=id&limit=0', 'data-service');
  if (authorizationRequired) return { authorizationRequired: true };
}
