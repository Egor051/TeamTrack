import { ConnectivityUnavailableError, isTransportFailure } from './errors';
import { reportRequestFailure, reportConnectivitySuccess, usesLocalReads, connectivityRequestEpoch } from './state';
import { boundedOperation } from './deadline';
let authRevalidations = 0;
export const AUTH_REQUEST_TIMEOUT_MS = 5000;
export const API_REQUEST_TIMEOUT_MS = 20_000;
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
async function fetchResponse(input: RequestInfo | URL, init: RequestInit | undefined, milliseconds: number, parent?: AbortSignal): Promise<Response> {
  let received: Response | undefined;
  try {
    return await boundedOperation(async (signal) => {
      const response = await fetch(input, { ...init, signal }); received = response;
      // Auth parses JSON after fetch resolves. Keep its body in the deadline,
      // otherwise refreshingDeferred can remain stuck after headers arrive.
      await response.clone().arrayBuffer();
      return response;
    }, milliseconds, parent);
  } catch (error) {
    if (!parent?.aborted && received && [401, 403].includes(received.status)) {
      // Preserve an actual server denial even if its body never completes.
      return new Response(JSON.stringify({ message: received.status === 401 ? 'Unauthorized' : 'Forbidden' }),
        { status: received.status, headers: { 'Content-Type': 'application/json' } });
    }
    throw error;
  }
}

// Shared safety net for auxiliary/unsupported queries and SDK retries. Cache
// reads bypass the SDK earlier, so they never reach this function offline.
export const connectivityFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const authRequest = /\/auth\/v1\//.test(url);
  const authRecovery = authRevalidations > 0 && authRequest;
  const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
  // An initial expired session refresh must also fail within a bounded time.
  // Otherwise a half-open mobile connection never reports failure, getSession
  // never releases cached reads, and the recovery probe cannot start.
  const epoch = connectivityRequestEpoch();
  if (usesLocalReads() && !authRecovery) throw aborted(new ConnectivityUnavailableError().message);
  try {
    const response = await fetchResponse(input, init, authRequest ? AUTH_REQUEST_TIMEOUT_MS : API_REQUEST_TIMEOUT_MS,
      init?.signal ?? request?.signal);
    if (init?.signal?.aborted || request?.signal.aborted) throw aborted('Operation cancelled');
    if (response.ok && !authRecovery && /\/rest\/v1\//.test(url)) reportConnectivitySuccess(epoch);
    else if ([502, 503, 504].includes(response.status)) {
      let error: { status: number; code?: string; message?: string } = { status: response.status };
      try {
        const body = await boundedOperation(() => response.clone().json(), 1000, init?.signal ?? request?.signal);
        error = { status: response.status, code: body?.code, message: body?.message };
      } catch { /* gateway HTML/empty response is still an availability failure */ }
      if (!init?.signal?.aborted && !request?.signal.aborted) reportRequestFailure(error, epoch);
    }
    return response;
  } catch (error) {
    if (!init?.signal?.aborted && !request?.signal.aborted) reportRequestFailure(error, epoch);
    // PostgREST retries TypeError GET failures (1s+2s+4s) by default. Once the
    // shared state is degraded, retrying that read cannot reach the server.
    if (isTransportFailure(error)) throw aborted((error as Error).message);
    throw error;
  }
};
