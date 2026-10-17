import { ConnectivityUnavailableError, isTransportFailure } from './errors';
import { browserIsOffline, reportConnectivityFailure, reportConnectivitySuccess, usesLocalReads, connectivityRequestEpoch } from './state';
import { boundedOperation } from './deadline';
let authRevalidations = 0;
export const AUTH_REQUEST_TIMEOUT_MS = 5000;
// Auth refresh retries span a 30s SDK tick. Recovery is background work and
// must allow an in-flight retry lifecycle to finish; individual fetches are 5s.
export const AUTH_REVALIDATION_TIMEOUT_MS = 35_000;
export async function revalidateAuthTransport<T>(restore: () => Promise<T>): Promise<T> {
  authRevalidations += 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Auth connectivity revalidation timed out')), AUTH_REVALIDATION_TIMEOUT_MS);
  });
  try { return await Promise.race([restore(), timeout]); }
  finally { if (timer) clearTimeout(timer); authRevalidations -= 1; }
}
function aborted(message: string): Error {
  const error = new Error(message); error.name = 'AbortError'; return error;
}

// Shared safety net for auxiliary/unsupported queries and SDK retries. Cache
// reads bypass the SDK earlier, so they never reach this function offline.
export const connectivityFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const authRequest = /\/auth\/v1\//.test(url);
  const authRecovery = authRevalidations > 0 && authRequest;
  const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  // An initial expired session refresh must also fail within a bounded time.
  // Otherwise a half-open mobile connection never reports failure, getSession
  // never releases cached reads, and the recovery probe cannot start.
  const authRefresh = authRequest && new URL(url).pathname.endsWith('/token')
    && new URL(url).searchParams.get('grant_type') === 'refresh_token';
  const boundedAuth = authRecovery || authRefresh || (authRequest && method === 'GET');
  const epoch = connectivityRequestEpoch();
  if (usesLocalReads() && (!authRecovery || browserIsOffline())) throw aborted(new ConnectivityUnavailableError().message);
  try {
    const response = boundedAuth
      ? await boundedOperation((signal) => fetch(input, { ...init, signal }), AUTH_REQUEST_TIMEOUT_MS,
        init?.signal ?? request?.signal)
      : await fetch(input, init);
    if (init?.signal?.aborted) throw aborted('Operation cancelled');
    if (response.ok && !authRecovery) reportConnectivitySuccess(epoch);
    else if ([502, 503, 504].includes(response.status)) {
      let error: { status: number; code?: string; message?: string } = { status: response.status };
      try {
        const body = await response.clone().json();
        error = { status: response.status, code: body?.code, message: body?.message };
      } catch { /* gateway HTML/empty response is still an availability failure */ }
      reportConnectivityFailure(error);
    }
    return response;
  } catch (error) {
    reportConnectivityFailure(error);
    // PostgREST retries TypeError GET failures (1s+2s+4s) by default. Once the
    // shared state is degraded, retrying that read cannot reach the server.
    if (isTransportFailure(error)) throw aborted((error as Error).message);
    throw error;
  }
};
