import { MAX_EVENT_BYTES, validClientErrorEvent, type ClientErrorEvent } from './client-error-schema.ts';

export type IngestResult = 'accepted' | 'duplicate' | 'rate_limited' | 'quota' | 'invalid' | 'account_unavailable';
type Dependencies = {
  allowedOrigins: ReadonlySet<string>;
  authenticate: (token: string, signal: AbortSignal) => Promise<string | null>;
  ingest: (userId: string, event: ClientErrorEvent, signal: AbortSignal) => Promise<IngestResult>;
};
async function body(request: Request, signal: AbortSignal): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > MAX_EVENT_BYTES) throw new RangeError();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError();
  const parts: Uint8Array[] = []; let length = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error();
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_EVENT_BYTES) { await reader.cancel(); throw new RangeError(); }
      parts.push(next.value);
    }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Pure ingress, exercised by unit and isolated HTTP/SQL integration tests. */
export function clientErrorHandler(deps: Dependencies): (request: Request) => Promise<Response> {
  return async request => {
    const origin = request.headers.get('origin');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (origin && !deps.allowedOrigins.has(origin)) return new Response(null, { status: 403, headers });
    if (origin) headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'authorization, apikey, content-type';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Max-Age'] = '86400';
    headers['Access-Control-Expose-Headers'] = 'X-Client-Error-Limit';
    const reply = (status: number) => new Response(status === 204 ? null : '{}', { status, headers });
    if (request.method === 'OPTIONS') return reply(204);
    if (request.method !== 'POST') return reply(405);
    const authorization = /^Bearer ([a-z\d._~-]{20,8192})$/i.exec(request.headers.get('authorization') ?? '');
    if (!authorization) return reply(401);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return reply(400);
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(abort, 4500);
    try {
      const work = async () => {
        let event: unknown;
        try { event = await body(request, controller.signal); } catch (error) { return reply(error instanceof RangeError ? 413 : 400); }
        if (!validClientErrorEvent(event)) return reply(400);
        const userId = await deps.authenticate(authorization[1], controller.signal);
        if (!userId) return reply(401);
        if (controller.signal.aborted) return reply(503);
        const result = await deps.ingest(userId, event, controller.signal);
        if (result === 'quota' || result === 'rate_limited') {
          headers['X-Client-Error-Limit'] = result === 'quota' ? 'day' : 'rate';
          headers['Retry-After'] = result === 'quota' ? '86400' : '30';
          return reply(429);
        }
        return reply(result === 'accepted' ? 201 : result === 'duplicate' ? 202 : result === 'account_unavailable' ? 401 : 400);
      };
      return await Promise.race([work(), new Promise<Response>(resolve => {
        if (controller.signal.aborted) resolve(reply(503));
        else controller.signal.addEventListener('abort', () => resolve(reply(503)), { once: true });
      })]);
    } catch { return reply(503); }
    finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
  };
}
