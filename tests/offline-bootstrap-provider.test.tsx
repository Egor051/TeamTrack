import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialBootstrap, type BootstrapMetadata } from '@/lib/local-cache/bootstrap-types';
import { reportBrowserConnectivity, reportConnectivitySuccess } from '@/lib/connectivity/state';

const f = vi.hoisted(() => ({ meta: null as BootstrapMetadata | null, run: vi.fn(), resume: vi.fn(), cancel: vi.fn(),
  specs: [] as { options: { onEvent: () => void; onStatus: (s: string) => void } }[],
  metadata: null as null | ((id: string) => void), unsubscribe: vi.fn(), remove: vi.fn(), foreground: null as null | ((s: string) => void) }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { addEventListener: (_: string, cb: (s: string) => void) => {
  f.foreground = cb; return { remove: f.remove };
} } }));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ state: { user: { id: 'user-a' }, session: { access_token: 'test' } } }) }));
vi.mock('@/lib/supabase/realtime', () => ({ subscribeMany: (specs: typeof f.specs) => { f.specs = specs; return f.unsubscribe; } }));
vi.mock('@/lib/local-cache/bootstrap', () => ({ BOOTSTRAP_REFRESH_MS: 300_000, runAccountBootstrap: f.run,
  resumeAccountBootstrap: f.resume,
  cancelAccountBootstrap: f.cancel, getBootstrapMetadata: async () => f.meta,
  bootstrapDelay: (m: BootstrapMetadata) => Math.max(0, (m.retry?.next_retry_at ?? 0) - Date.now(),
    m.last_attempt_at === undefined ? 0 : m.last_attempt_at + 30_000 - Date.now()),
  subscribeBootstrap: (cb: (id: string) => void) => { f.metadata = cb; return () => { f.metadata = null; }; } }));
import { OfflineBootstrapProvider } from '@/lib/local-cache/OfflineBootstrapProvider';

let renderer: ReactTestRenderer | null;
const windowEvents = new EventTarget(); const documentEvents = new EventTarget();
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function mount() { await act(async () => { renderer = create(createElement(OfflineBootstrapProvider, { children: 'app' })); }); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T00:00:00Z')); vi.clearAllMocks();
  f.meta = initialBootstrap('user-a'); renderer = null;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('navigator', { onLine: true }); vi.stubGlobal('window', windowEvents);
  vi.stubGlobal('document', Object.assign(documentEvents, { visibilityState: 'visible' }));
  f.run.mockImplementation(async () => {
    f.meta = { ...f.meta!, status: 'ready', last_attempt_at: Date.now(), last_successful_sync_at: new Date().toISOString() };
    return 'settled';
  });
  f.resume.mockImplementation(async () => { f.meta = { ...f.meta!, status: 'ready', offline_ready: true }; return 'settled'; });
});
afterEach(async () => {
  await act(async () => { renderer?.unmount(); }); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
describe('bootstrap trigger coalescing and cleanup', () => {
  it('automatically resumes offline_waiting on confirmed connectivity despite old retry gates', async () => {
    vi.stubGlobal('navigator', { onLine: false }); reportBrowserConnectivity(false);
    f.run.mockImplementation(async () => {
      f.meta = { ...f.meta!, status: 'offline_waiting', retry: { failures: 3, next_retry_at: Date.now() + 300_000 } };
      return 'settled';
    });
    await mount(); await tick(400);
    expect(f.meta?.status).toBe('offline_waiting');
    vi.stubGlobal('navigator', { onLine: true }); reportConnectivitySuccess(); await tick(400);
    expect(f.resume).toHaveBeenCalledOnce(); expect(f.meta?.status).toBe('ready');
  });
  it('coalesces 50 Realtime events and repeated connected statuses into one refresh', async () => {
    await mount(); await tick(400); expect(f.run).toHaveBeenCalledTimes(1);
    await tick(1);
    f.specs.forEach((s) => s.options.onStatus('connected'));
    for (let i = 0; i < 50; i++) f.specs[i % f.specs.length].options.onEvent();
    await tick(29_999); expect(f.run).toHaveBeenCalledTimes(1);
    await tick(501); expect(f.run).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 100; i++) f.specs[i % f.specs.length].options.onStatus('connected');
    f.metadata?.('user-a'); await tick(30_000); expect(f.run).toHaveBeenCalledTimes(2);
  });
  it('online, visible, foreground and reconnect events cannot reset the persisted backoff', async () => {
    f.run.mockImplementation(async () => {
      f.meta = { ...f.meta!, status: 'error', last_attempt_at: Date.now(), retry: { failures: 1, next_retry_at: Date.now() + 60_000 } };
      return 'settled';
    });
    await mount(); await tick(400);
    for (let i = 0; i < 100; i++) {
      windowEvents.dispatchEvent(new Event('online')); documentEvents.dispatchEvent(new Event('visibilitychange'));
      f.foreground?.('active'); f.specs[0].options.onStatus('disconnected'); f.specs[0].options.onStatus('connected');
    }
    await tick(60_000); expect(f.run).toHaveBeenCalledTimes(1);
    await tick(100); expect(f.run).toHaveBeenCalledTimes(2);
  });
  it('does not fan out running completion callbacks or restart after unmount', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    f.run.mockImplementation(async () => { await gate; return 'busy'; });
    await mount(); await tick(400);
    for (let i = 0; i < 50; i++) f.specs[0].options.onEvent();
    expect(f.run).toHaveBeenCalledTimes(1);
    await act(async () => { renderer!.unmount(); renderer = null; });
    release(); await tick(600_000);
    windowEvents.dispatchEvent(new Event('online')); documentEvents.dispatchEvent(new Event('visibilitychange'));
    expect(f.run).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    expect(f.cancel).toHaveBeenCalledWith('user-a'); expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.remove).toHaveBeenCalledOnce(); expect(f.metadata).toBeNull();
  });
});
