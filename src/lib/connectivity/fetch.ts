import { ConnectivityUnavailableError, isTransportFailure } from './errors';
import { browserIsOffline, reportConnectivityFailure, reportConnectivitySuccess, usesLocalReads, connectivityRequestEpoch } from './state';
import { requestDeadline } from './deadline';
let authRevalidations = 0;
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
  const authRecovery = authRevalidations > 0 && /\/auth\/v1\//.test(url);
  const epoch = connectivityRequestEpoch();
  if (usesLocalReads() && (!authRecovery || browserIsOffline())) throw aborted(new ConnectivityUnavailableError().message);
  const deadline = authRecovery ? requestDeadline(5000) : null;
  try {
    const response = await fetch(input, deadline ? { ...init, signal: init?.signal ?? deadline.signal } : init);
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
    if (deadline?.expired() && (error as Error)?.name === 'AbortError') error = new Error('Auth connectivity request timed out');
    reportConnectivityFailure(error);
    // PostgREST retries TypeError GET failures (1s+2s+4s) by default. Once the
    // shared state is degraded, retrying that read cannot reach the server.
    if (isTransportFailure(error)) throw aborted((error as Error).message);
    throw error;
  } finally { deadline?.dispose(); }
};
