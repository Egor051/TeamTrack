import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientErrorHandler } from '../supabase/functions/_shared/client-error-handler';
import { diagnosticEvent } from './client-error-fixtures';

afterEach(() => vi.useRealTimers());
const user = 'a28f0000-0000-4000-8000-000000000001';
function fixture() {
  const authenticate = vi.fn(async () => user), ingest = vi.fn(async () => 'accepted' as const);
  const handle = clientErrorHandler({ allowedOrigins: new Set(['https://tasktrace.ru']), authenticate, ingest });
  const request = (body: unknown = diagnosticEvent(), headers: Record<string, string> = {}) => new Request('https://local/functions/v1/client-errors', {
    method: 'POST', headers: { Origin: 'https://tasktrace.ru', Authorization: `Bearer ${'a'.repeat(40)}`, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { authenticate, ingest, handle, request };
}
describe('verified Edge diagnostic ingress', () => {
  it('uses only the identity returned by Auth and does not require the Data API', async () => {
    const f = fixture(), event = diagnosticEvent();
    const response = await f.handle(f.request(event));
    expect(response.status).toBe(201); expect(f.ingest).toHaveBeenCalledWith(user, event, expect.any(AbortSignal));
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://tasktrace.ru');
  });
  it('rejects forged identity, nested secrets, invalid values and unauthenticated requests', async () => {
    const f = fixture(), e = diagnosticEvent();
    for (const bad of [{ ...e, user_id: user }, { ...e, error: { ...e.error, message: 'secret' } }, { ...e, kind: 'activity' }, { ...e, protocol_version: 999 }])
      expect((await f.handle(f.request(bad))).status).toBe(400);
    expect(f.authenticate).not.toHaveBeenCalled(); expect(f.ingest).not.toHaveBeenCalled();
    expect((await f.handle(f.request(e, { Authorization: '' }))).status).toBe(401);
    f.authenticate.mockResolvedValueOnce(null as unknown as string);
    expect((await f.handle(f.request(e))).status).toBe(401); expect(f.ingest).not.toHaveBeenCalled();
  });
  it('limits actual UTF-8 body bytes, including whitespace and multibyte text', async () => {
    const f = fixture(), json = JSON.stringify(diagnosticEvent());
    expect((await f.handle(f.request(json.padEnd(4096, ' ')))).status).toBe(201);
    expect((await f.handle(f.request(json.padEnd(4097, ' ')))).status).toBe(413);
    expect((await f.handle(f.request('я'.repeat(2500)))).status).toBe(413);
    expect(f.ingest).toHaveBeenCalledOnce();
  });
  it('allows preflight only for approved origins and exposes no raw server exception', async () => {
    const f = fixture();
    expect((await f.handle(new Request('https://local', { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } }))).status).toBe(403);
    expect((await f.handle(new Request('https://local', { method: 'OPTIONS', headers: { Origin: 'https://tasktrace.ru' } }))).status).toBe(204);
    f.ingest.mockRejectedValueOnce(new Error('SECRET_DB_URL TOKEN SQL internal'));
    const r = await f.handle(f.request()); expect(r.status).toBe(503); expect(await r.text()).toBe('{}');
    expect(f.authenticate).toHaveBeenCalledOnce();
  });
  it('distinguishes rate throttling from the server daily quota', async () => {
    const f = fixture();
    f.ingest.mockResolvedValueOnce('rate_limited' as 'accepted');
    const rate = await f.handle(f.request()); expect(rate.status).toBe(429); expect(rate.headers.get('X-Client-Error-Limit')).toBe('rate');
    f.ingest.mockResolvedValueOnce('quota' as 'accepted');
    const quota = await f.handle(f.request()); expect(quota.headers.get('X-Client-Error-Limit')).toBe('day');
  });
  it('bounds hanging Auth and never starts an ingest after the deadline', async () => {
    vi.useFakeTimers(); const f = fixture(); let finish!: (value: string) => void;
    f.authenticate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const work = f.handle(f.request()); await vi.advanceTimersByTimeAsync(4501);
    expect((await work).status).toBe(503); finish(user); await Promise.resolve();
    expect(f.ingest).not.toHaveBeenCalled();
  });
});
