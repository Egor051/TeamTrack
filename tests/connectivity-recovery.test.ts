import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectivityFetch, AUTH_REQUEST_TIMEOUT_MS, API_REQUEST_TIMEOUT_MS } from '@/lib/connectivity/fetch';
import { CONNECTIVITY_PROBE_INTERVAL_MS, CONNECTIVITY_PROBE_TIMEOUT_MS, OFFLINE_HINT_RECHECK_MS, connectivityRequestEpoch,
  getConnectivityState, monitorConnectivity, reportBrowserConnectivity, reportConnectivityFailure,
  reportRequestFailure, revalidateConnectivity, usesLocalReads } from '@/lib/connectivity/state';
import { getNetworkFacts } from '@/lib/local-cache/runtime-state';
import { probeSupabase } from '@/lib/supabase/connectivity-probe';
import { uiRead, UI_READ_TIMEOUT_MS } from '@/lib/supabase/ui-read';

const health = () => new Response('{"name":"GoTrue","version":"test"}');
const stored = async () => ({ access_token: 'fixture-user-token' });
let stop: (() => void) | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('navigator', { onLine: true }); });
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('request failures versus service availability', () => {
  it('an isolated endpoint timeout uses a shared confirmation without changing global connectivity', async () => {
    const check = vi.fn(async () => undefined); stop = monitorConnectivity(check);
    const epoch = connectivityRequestEpoch();
    for (let i = 0; i < 50; i++) reportRequestFailure(new TypeError('Failed to fetch'), epoch);
    expect(getConnectivityState()).toBe('online');
    await vi.advanceTimersByTimeAsync(250);
    expect(check).toHaveBeenCalledOnce(); expect(getConnectivityState()).toBe('online');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('an Auth request failure cannot declare all services offline when its confirmation succeeds', async () => {
    stop = monitorConnectivity(async () => undefined);
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    const request = connectivityFetch('https://server.test/auth/v1/user');
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS + 250); await rejected;
    expect(getConnectivityState()).toBe('online');
  });
  it('a late failed request cannot overwrite a successful newer recovery', async () => {
    let reject!: (error: Error) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((_resolve, fail) => { reject = fail; })));
    stop = monitorConnectivity(async () => undefined);
    const old = connectivityFetch('https://server.test/rest/v1/projects');
    const rejected = expect(old).rejects.toThrow('Failed to fetch');
    await revalidateConnectivity(true);
    reject(new TypeError('Failed to fetch')); await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    expect(getConnectivityState()).toBe('online'); expect(vi.getTimerCount()).toBe(0);
  });
  it('a new confirmed failure fences the success of an already running probe', async () => {
    let release!: () => void;
    stop = monitorConnectivity(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = revalidateConnectivity(); await vi.advanceTimersByTimeAsync(0);
    reportConnectivityFailure(new TypeError('Failed to fetch'));
    release(); await pending;
    expect(getConnectivityState()).toBe('degraded');
  });
  it.each([401, 403, 429])('does not interpret HTTP %s as a disconnected Internet', async (status) => {
    const check = vi.fn(async () => undefined); stop = monitorConnectivity(check);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"Request rejected"}', { status })));
    expect((await connectivityFetch('https://server.test/rest/v1/projects')).status).toBe(status);
    await vi.advanceTimersByTimeAsync(1000);
    expect(check).not.toHaveBeenCalled(); expect(getConnectivityState()).toBe('online');
  });
});

describe('bounded service proofs', () => {
  it.each([['token?grant_type=password', 'POST'], ['signup', 'POST'], ['recover', 'POST'], ['user', 'PUT'], ['logout?scope=local', 'POST']])('BUG-05 bounds interactive Auth %s %s including a stalled body', async (path, method) => {
    stop = monitorConnectivity(async () => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }))));
    const rejected = expect(connectivityFetch(`https://server.test/auth/v1/${path}`, { method })).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS); await rejected;
  });
  it('BUG-05 bounds a REST mutation whose transport ignores cancellation', async () => {
    stop = monitorConnectivity(async () => undefined); vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const rejected = expect(connectivityFetch('https://server.test/rest/v1/rpc/create_task', { method: 'POST' })).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS); await rejected;
  });
  it.each([401, 403])('classifies probe HTTP %s as an authorization problem without entering offline', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"code":"42501","message":"Denied"}', { status })));
    stop = monitorConnectivity((signal) => probeSupabase('https://server.test', 'fixture-key', stored, signal));
    await revalidateConnectivity(true);
    expect(getConnectivityState()).toBe('online');
    expect(getNetworkFacts()).toMatchObject({ backend: 'reachable', issue: 'authorization' });
  });
  it.each(['auth-service', 'data-service'] as const)('identifies unavailable %s independently of the browser network', async (service) => {
    vi.stubGlobal('fetch', vi.fn(async (input) => String(input).includes('/health') && service === 'data-service'
      ? health() : new Response('Gateway unavailable', { status: 503 })));
    stop = monitorConnectivity((signal) => probeSupabase('https://server.test', 'publishable-fixture', stored, signal));
    await revalidateConnectivity(true);
    expect(getConnectivityState()).toBe('degraded');
    expect(getNetworkFacts()).toMatchObject({ physical: 'connected', backend: 'unavailable', issue: service });
  });
  it.each(['headers', 'body'] as const)('settles when probe %s ignore abort and recovers on the next attempt', async (stalled) => {
    const fetch = vi.fn((): Promise<Response> => stalled === 'headers' ? new Promise(() => undefined)
      : Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => undefined) } as unknown as Response));
    vi.stubGlobal('fetch', fetch);
    stop = monitorConnectivity((signal) => probeSupabase('https://server.test', 'publishable-fixture', stored, signal));
    const pending = revalidateConnectivity(true);
    await vi.advanceTimersByTimeAsync(5000); await pending;
    expect(getConnectivityState()).toBe('degraded');
    fetch.mockImplementation(async (input?: unknown) => String(input).includes('/health') ? health() : new Response('[]'));
    await revalidateConnectivity(true); expect(getConnectivityState()).toBe('online');
  });
  it('rejects HTML/200 and does not mistake a captive portal for a healthy backend', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Sign in to Wi-Fi</html>')));
    stop = monitorConnectivity((signal) => probeSupabase('https://server.test', 'key', stored, signal));
    await revalidateConnectivity(true);
    expect(getNetworkFacts()).toMatchObject({ backend: 'unavailable', issue: 'auth-service' });
  });
  it('aborts superseded network work and fences its late completion', async () => {
    const signals: AbortSignal[] = []; let release!: () => void;
    const check = vi.fn().mockImplementationOnce((signal: AbortSignal) => {
      signals.push(signal); return new Promise<void>((resolve) => { release = resolve; });
    }).mockResolvedValue(undefined);
    stop = monitorConnectivity(check);
    const old = revalidateConnectivity(); await vi.advanceTimersByTimeAsync(0);
    await revalidateConnectivity(true); expect(signals[0].aborted).toBe(true);
    release(); await old; expect(getConnectivityState()).toBe('online'); expect(vi.getTimerCount()).toBe(0);
  });
  it('an unexpected or never settling probe fails finitely and schedules recovery', async () => {
    const check = vi.fn().mockImplementationOnce(() => new Promise<void>(() => undefined)).mockResolvedValue(undefined);
    stop = monitorConnectivity(check);
    const pending = revalidateConnectivity(true);
    await vi.advanceTimersByTimeAsync(CONNECTIVITY_PROBE_TIMEOUT_MS); await pending;
    expect(getConnectivityState()).toBe('degraded');
    await vi.advanceTimersByTimeAsync(CONNECTIVITY_PROBE_INTERVAL_MS);
    expect(getConnectivityState()).toBe('online'); expect(check).toHaveBeenCalledTimes(2);
  });
  it('a UI query that ignores AbortSignal still settles at its deadline', async () => {
    const pending = uiRead(new Promise(() => undefined));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(UI_READ_TIMEOUT_MS); await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('automatic and explicit reconnect', () => {
  it('an immediate online event after a failed offline Refresh bypasses its offline timer', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const check = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(undefined);
    stop = monitorConnectivity(check); await revalidateConnectivity(true);
    vi.stubGlobal('navigator', { onLine: true }); reportBrowserConnectivity(true);
    await revalidateConnectivity();
    expect(check).toHaveBeenCalledTimes(2); expect(getConnectivityState()).toBe('online');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('a foreground check in the cooldown schedules the remaining second instead of keeping a long retry', async () => {
    const check = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(undefined);
    stop = monitorConnectivity(check); await revalidateConnectivity(true);
    await revalidateConnectivity(); await vi.advanceTimersByTimeAsync(1000);
    expect(check).toHaveBeenCalledTimes(2); expect(getConnectivityState()).toBe('online');
  });
  it('automatically detects a missed online event from a previously disconnected state', async () => {
    vi.stubGlobal('navigator', { onLine: false }); const check = vi.fn(async () => undefined);
    stop = monitorConnectivity(check); expect(usesLocalReads()).toBe(true);
    vi.stubGlobal('navigator', { onLine: true });
    await vi.advanceTimersByTimeAsync(OFFLINE_HINT_RECHECK_MS);
    expect(getConnectivityState()).toBe('online'); expect(check).toHaveBeenCalledOnce();
  });
  it('automatically verifies services even when the negative browser hint never updates', async () => {
    vi.stubGlobal('navigator', { onLine: false }); const check = vi.fn(async () => undefined);
    stop = monitorConnectivity(check);
    await vi.advanceTimersByTimeAsync(OFFLINE_HINT_RECHECK_MS - 1); expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(getConnectivityState()).toBe('online'); expect(check).toHaveBeenCalledOnce();
  });
  it('focus and visibility events refresh an old service proof without duplicate checks', async () => {
    const events = new EventTarget(); vi.stubGlobal('window', events);
    const check = vi.fn(async () => undefined); stop = monitorConnectivity(check);
    await revalidateConnectivity(true); await vi.advanceTimersByTimeAsync(CONNECTIVITY_PROBE_INTERVAL_MS);
    for (let i = 0; i < 50; i++) events.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0); expect(check).toHaveBeenCalledTimes(2);
    expect(getConnectivityState()).toBe('online');
  });
  it('an explicit proof overrides a stale navigator.onLine=false hint', async () => {
    vi.stubGlobal('navigator', { onLine: false }); stop = monitorConnectivity(async () => undefined);
    await revalidateConnectivity(true); expect(usesLocalReads()).toBe(false);
    reportBrowserConnectivity(false); expect(usesLocalReads()).toBe(true);
  });
  it('retries service outages with bounded backoff and no concurrent checks', async () => {
    const check = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')); stop = monitorConnectivity(check);
    await revalidateConnectivity(true);
    await vi.advanceTimersByTimeAsync(CONNECTIVITY_PROBE_INTERVAL_MS - 1); expect(check).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999); expect(check).toHaveBeenCalledTimes(2);
    check.mockResolvedValue(undefined); await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(3); expect(getConnectivityState()).toBe('online');
  });
  it('manual verification resets only the connectivity retry backoff', async () => {
    const check = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')); stop = monitorConnectivity(check);
    await revalidateConnectivity(true); await vi.advanceTimersByTimeAsync(90_000);
    expect(check).toHaveBeenCalledTimes(3);
    await revalidateConnectivity(true); check.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(CONNECTIVITY_PROBE_INTERVAL_MS);
    expect(getConnectivityState()).toBe('online'); expect(check).toHaveBeenCalledTimes(5);
  });
});
