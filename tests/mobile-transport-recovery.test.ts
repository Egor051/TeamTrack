import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_REQUEST_TIMEOUT_MS, connectivityFetch, revalidateAuthTransport } from '@/lib/connectivity/fetch';
import { getConnectivityState, reportConnectivityFailure } from '@/lib/connectivity/state';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('navigator', { onLine: true });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('mobile Auth transport during a half-open connection', () => {
  it.each([false, true])('bounds the initial Auth request even with a caller signal: %s', async (withSignal) => {
    const parent = new AbortController();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn((_input, init) => new Promise((_resolve, reject) => {
      signal = init?.signal;
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
    })));
    let failure: Error | undefined;
    const request = connectivityFetch('https://server.test/auth/v1/token?grant_type=refresh_token',
      { method: 'POST', ...(withSignal ? { signal: parent.signal } : {}) }).catch((error) => { failure = error; });
    await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS);
    expect(failure, 'a stalled first refresh must release Auth startup').toBeDefined();
    expect(failure).toMatchObject({ name: 'AbortError' });
    expect(signal?.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    expect(getConnectivityState()).toBe('degraded');
    await request;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('releases an Auth read even when the transport ignores abort', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    let failure: Error | undefined;
    const request = connectivityFetch(new Request('https://server.test/auth/v1/user'))
      .catch((error) => { failure = error; });
    await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS);
    expect(failure).toMatchObject({ name: 'AbortError' });
    expect(getConnectivityState()).toBe('degraded');
    await request;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('caller cancellation neither degrades connectivity nor leaves a deadline', async () => {
    const parent = new AbortController();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn((_input, init) => new Promise((_resolve, reject) => {
      signal = init?.signal;
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
    })));
    const request = connectivityFetch(new Request('https://server.test/auth/v1/user', { signal: parent.signal }));
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    parent.abort();
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(getConnectivityState()).toBe('online');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('the recovery deadline still applies when the SDK supplied its own signal', async () => {
    reportConnectivityFailure(new TypeError('Failed to fetch'));
    const parent = new AbortController();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    let failure: Error | undefined;
    const request = revalidateAuthTransport(() => connectivityFetch('https://server.test/auth/v1/token?grant_type=refresh_token',
      { method: 'POST', signal: parent.signal })).catch((error) => { failure = error; });
    await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS);
    expect(failure).toMatchObject({ name: 'AbortError' });
    expect(getConnectivityState()).toBe('degraded');
    expect(parent.signal.aborted).toBe(false);
    await request;
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([401, 403])('keeps HTTP %s authoritative instead of classifying it as a network failure', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Denied"}', { status })));
    const response = await connectivityFetch('https://server.test/auth/v1/user');
    expect(response.status).toBe(status);
    expect(getConnectivityState()).toBe('online');
    expect(vi.getTimerCount()).toBe(0);
  });
});
