import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOfflineCoordinator, OFFLINE_TICK_MS, type CoordinatorDependencies } from '@/lib/local-cache/coordinator';
import { initialBootstrap, type BootstrapMetadata } from '@/lib/local-cache/bootstrap-types';
import { getNetworkFacts, getOfflineRuntime, invalidateOfflineRuntime, publishBootstrapFacts,
  startRuntimeOperation } from '@/lib/local-cache/runtime-state';
import { monitorConnectivity, getConnectivityState, reportBrowserConnectivity, reportConnectivityFailure,
  reportConnectivitySuccess } from '@/lib/connectivity/state';

let meta: BootstrapMetadata;
let local: boolean;
let coordinator: ReturnType<typeof createOfflineCoordinator> | null;
let deps: CoordinatorDependencies;
const ready = () => { meta = { ...meta, status: 'ready', progress: 100, basic_ready: true, offline_ready: true,
  extended_ready: meta.scheme === 'extended', retry: null, error: null, last_successful_sync_at: new Date().toISOString() }; };
const tick = (ms = 400) => vi.advanceTimersByTimeAsync(ms);
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('navigator', { onLine: true });
  meta = initialBootstrap('a'); local = false; coordinator = null;
  deps = { local: () => local, probe: vi.fn(async () => undefined), session: vi.fn(async () => true),
    metadata: vi.fn(async () => structuredClone(meta)), prepare: vi.fn(async () => {
      if (local) meta = { ...meta, status: meta.basic_ready ? 'ready' : 'offline_waiting' };
      else ready(); return 'settled' as const;
    }), sync: vi.fn(async () => undefined), cancelPreparation: vi.fn(), cancelSync: vi.fn(),
    delay: (m) => Math.max(0, (m.retry?.next_retry_at ?? 0) - Date.now()), preloadEnabled: true };
});
afterEach(() => { coordinator?.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('authoritative offline operation lifecycle', () => {
  it('runtime snapshots contain facts and cannot duplicate preparation lifecycle or progress', () => {
    publishBootstrapFacts('a', { ...meta, status: 'running', progress: 94, started_at: new Date().toISOString() });
    expect(getOfflineRuntime('a').bootstrap).not.toHaveProperty('status');
    expect(getOfflineRuntime('a').bootstrap).not.toHaveProperty('progress');
    expect(getOfflineRuntime('a').bootstrap).not.toHaveProperty('started_at');
  });
  it('operation A → B → B finishes → late A cannot overwrite B', () => {
    const a = startRuntimeOperation('a', 'preparation', 'preparation', 20_000, true);
    const b = startRuntimeOperation('a', 'preparation', 'preparation', 20_000, true);
    b.finish('success'); a.update({ visible: true, progress: { done: 94, total: 100 } }); a.finish('error');
    publishBootstrapFacts('a', { ...meta, status: 'error' }, a);
    expect(getOfflineRuntime('a').operations.preparation).toMatchObject({ id: b.id, phase: 'settled', outcome: 'success', progress: null });
    expect(getOfflineRuntime('a').bootstrap).toBeNull();
  });
  it('progress 94 is metadata and cannot retain preparation after success', () => {
    const op = startRuntimeOperation('a', 'preparation', 'preparation', 20_000, true);
    op.update({ progress: { done: 94, total: 100 } }); op.finish('success');
    expect(getOfflineRuntime('a').operations.preparation).toMatchObject({ phase: 'settled', outcome: 'success', progress: null, visible: false });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['preparation', 'sync', 'pipeline'] as const)('%s has a watchdog error outcome even when work never resolves', async (slot) => {
    const op = startRuntimeOperation('a', slot, 'recovery', 1000, true); await tick(1000);
    expect(op.signal.aborted).toBe(true);
    expect(getOfflineRuntime('a').operations[slot]).toMatchObject({ phase: 'settled', outcome: 'error', visible: false });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('invalidates same-account operations across logout/login and isolates another account', () => {
    const a = startRuntimeOperation('a', 'sync', 'synchronization', 20_000, true);
    const b = startRuntimeOperation('b', 'sync', 'synchronization', 20_000, true);
    invalidateOfflineRuntime('a'); a.finish('success'); a.update({ visible: true });
    expect(a.current()).toBe(false); expect(b.current()).toBe(true);
    expect(getOfflineRuntime('a').operations.sync?.outcome).toBe('cancelled'); b.finish('success');
  });
});
describe('one recovery pipeline', () => {
  it('foreground ticks leave a fully ready cache quiet beyond its former refresh TTL', async () => {
    ready(); deps.syncNeeded = vi.fn(async () => false);
    coordinator = createOfflineCoordinator('a', deps);
    await coordinator.request('freshness'); await tick(); await tick(10 * 60_000);
    expect(deps.metadata).toHaveBeenCalledTimes(31);
    expect(deps.session).not.toHaveBeenCalled(); expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.sync).not.toHaveBeenCalled(); expect(deps.prepare).not.toHaveBeenCalled();
    expect(meta.status).toBe('ready'); expect(vi.getTimerCount()).toBe(1);
  });
  it('the safety tick discovers missing readiness and pending work without a UI event', async () => {
    ready(); let pending = false; deps.syncNeeded = async () => pending;
    deps.sync = vi.fn(async () => { pending = false; });
    coordinator = createOfflineCoordinator('a', deps); await coordinator.request('freshness'); await tick();
    pending = true; meta.basic_ready = false; meta.status = 'partial';
    await tick(OFFLINE_TICK_MS);
    expect(deps.sync).toHaveBeenCalledOnce(); expect(deps.prepare).toHaveBeenCalledOnce();
    expect(meta.basic_ready).toBe(true);
  });
  it('hidden tabs do no periodic work and recheck on foreground', async () => {
    ready(); let visible = true; deps.foreground = () => visible;
    coordinator = createOfflineCoordinator('a', deps); await coordinator.request('freshness'); await tick();
    visible = false; await tick(120_000); expect(deps.metadata).toHaveBeenCalledOnce();
    meta.basic_ready = false; visible = true; await coordinator.request('freshness'); await tick();
    expect(deps.prepare).toHaveBeenCalledOnce(); expect(meta.basic_ready).toBe(true);
  });
  it('queued offline edits wait quietly for reconnect instead of spinning completion ticks', async () => {
    ready(); local = true;
    coordinator = createOfflineCoordinator('a', deps); await coordinator.request('mutations'); await tick();
    await tick(60_000); expect(deps.metadata).toHaveBeenCalledTimes(4);
    expect(deps.sync).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
    local = false; await coordinator.request('reconnect'); expect(deps.sync).toHaveBeenCalledOnce();
  });
  it('a long foreground return checks pull once without reloading a complete cache', async () => {
    ready(); coordinator = createOfflineCoordinator('a', deps);
    await coordinator.request('freshness'); await tick(); await tick(10 * 60_000);
    expect(deps.sync).not.toHaveBeenCalled();
    await coordinator.request('freshness'); await tick(); expect(deps.sync).toHaveBeenCalledOnce();
    for (let i = 0; i < 50; i++) await coordinator.request('freshness'); await tick();
    expect(deps.sync).toHaveBeenCalledOnce(); expect(deps.prepare).not.toHaveBeenCalled();
  });
  it('foreground bursts cannot bypass escalating recovery backoff, but edits sync promptly', async () => {
    deps.prepare = vi.fn(async () => { meta.status = 'error'; meta.error = 'quota'; return 'settled' as const; });
    coordinator = createOfflineCoordinator('a', deps); await coordinator.request('freshness'); await tick();
    expect(deps.prepare).toHaveBeenCalledOnce();
    for (let i = 0; i < 50; i++) await coordinator.request('freshness');
    await coordinator.request('mutations'); await tick();
    expect(deps.sync).toHaveBeenCalledTimes(2); expect(deps.prepare).toHaveBeenCalledOnce();
    await tick(4650); expect(deps.prepare).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 50; i++) await coordinator.request('freshness');
    await tick(9000); expect(deps.prepare).toHaveBeenCalledTimes(2);
    await tick(1050); expect(deps.prepare).toHaveBeenCalledTimes(3);
  });
  it('manual Refresh and trigger bursts join a live pipeline without concurrent workers', async () => {
    let release!: () => void; let active = 0; let peak = 0;
    deps.sync = vi.fn(async () => { peak = Math.max(peak, ++active); await new Promise<void>((resolve) => { release = resolve; }); active--; });
    coordinator = createOfflineCoordinator('a', deps); await coordinator.request('freshness'); await tick();
    const refresh = coordinator.request('manual-refresh');
    expect(coordinator.request('manual-refresh')).toBe(refresh);
    for (let i = 0; i < 50; i++) void coordinator.request('freshness');
    release(); await refresh; expect(peak).toBe(1); expect(meta.basic_ready).toBe(true);
    expect(deps.sync).toHaveBeenCalledOnce();
  });
  it('sync retry deadlines share the tick timer and do not wait for recovery backoff', async () => {
    ready(); meta.basic_ready = false;
    meta.retry = { failures: 4, next_retry_at: Date.now() + 300_000 };
    deps.sync = vi.fn(async () => undefined);
    coordinator = createOfflineCoordinator('a', deps); await coordinator.request('freshness'); await tick();
    await coordinator.request('sync-retry', 3000); await tick(3000);
    expect(deps.sync).toHaveBeenCalledOnce(); expect(deps.prepare).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });
  it('AUD-12: an edit arriving during sync survives the following preparation failure', async () => {
    let finish!: () => void;
    deps.sync = vi.fn(async (): Promise<void> => undefined).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    deps.prepare = vi.fn(async () => { ready(); throw new Error('storage failed'); });
    coordinator = createOfflineCoordinator('a', deps);
    await coordinator.request('freshness'); await tick();
    expect(deps.sync).toHaveBeenCalledOnce();
    void coordinator.request('mutations'); finish(); await tick(0);
    await tick(5100);
    expect(deps.sync).toHaveBeenCalledTimes(2);
  });
  it.each(['busy', 'error', 'backoff'])('AUD-12: a queued mutation survives preparation %s and a newly fresh snapshot', async (outcome) => {
    let finish!: () => void;
    deps.prepare = vi.fn(async () => { await new Promise<void>((resolve) => { finish = resolve; });
      ready(); if (outcome === 'error') throw new Error('storage failed'); return 'busy' as const;
    });
    if (outcome === 'backoff') deps.delay = () => { ready(); void coordinator!.request('mutations'); return 1000; };
    coordinator = createOfflineCoordinator('a', deps);
    await coordinator.request('freshness'); await tick();
    expect(deps.sync).toHaveBeenCalledOnce();
    if (outcome !== 'backoff') { void coordinator.request('mutations'); finish(); await tick(0); }
    await tick(5100);
    expect(deps.sync).toHaveBeenCalledTimes(2);
  });
  it('online startup verifies backend/session, syncs, prepares and reaches ready in order', async () => {
    const order: string[] = [];
    deps.probe = vi.fn(async () => { order.push('backend'); }); deps.session = vi.fn(async () => { order.push('session'); return true; });
    deps.sync = vi.fn(async () => { order.push('sync'); }); deps.prepare = vi.fn(async () => { order.push('preload'); ready(); return 'settled' as const; });
    coordinator = createOfflineCoordinator('a', deps); await coordinator.request('startup'); await tick();
    expect(order).toEqual(['backend', 'session', 'sync', 'preload']); expect(meta.basic_ready).toBe(true);
    expect(getOfflineRuntime('a').operations.pipeline).toMatchObject({ phase: 'settled', outcome: 'success' });
  });
  it('cold offline start uses local data and recovers after network returns without reload', async () => {
    ready(); local = true; coordinator = createOfflineCoordinator('a', deps);
    await coordinator.request('startup'); await tick();
    expect(meta.basic_ready).toBe(true); expect(deps.sync).not.toHaveBeenCalled();
    expect(getOfflineRuntime('a').operations.pipeline?.outcome).toBe('waiting-network');
    local = false; await coordinator.request('reconnect');
    expect(deps.session).toHaveBeenCalledOnce(); expect(deps.sync).toHaveBeenCalledOnce();
    expect(getOfflineRuntime('a').operations.pipeline?.outcome).toBe('success');
  });
  it('preparation interrupted at 94% → reconnect → ready, with late completion ignored', async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    deps.prepare = vi.fn().mockImplementationOnce(async () => { meta.progress = 94; await gate; return 'settled' as const; })
      .mockImplementation(async () => { ready(); return 'settled' as const; });
    coordinator = createOfflineCoordinator('a', deps); await coordinator.request('startup'); await tick();
    const oldId = getOfflineRuntime('a').operations.pipeline!.id;
    local = true; coordinator.networkLost(); local = false; await coordinator.request('reconnect');
    const current = getOfflineRuntime('a').operations.pipeline!; expect(current.id).not.toBe(oldId);
    expect(current.outcome).toBe('success'); release(); await tick(0);
    expect(getOfflineRuntime('a').operations.pipeline).toEqual(current); expect(meta.progress).toBe(100);
  });
  it('recoverable error → Retry supersedes the old pipeline and really prepares again', async () => {
    deps.prepare = vi.fn().mockRejectedValueOnce(new Error('storage unavailable')).mockImplementation(async () => { ready(); return 'settled' as const; });
    coordinator = createOfflineCoordinator('a', deps); await coordinator.request('startup'); await tick();
    expect(getOfflineRuntime('a').operations.pipeline?.outcome).toBe('error');
    await coordinator.request('retry');
    expect(deps.probe).toHaveBeenLastCalledWith(true); expect(deps.prepare).toHaveBeenLastCalledWith('retry', true);
    expect(meta.basic_ready).toBe(true); expect(deps.cancelPreparation).toHaveBeenCalled();
  });
  it('multiple reconnect events share one recovery and no duplicate preparation', async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    deps.probe = vi.fn(() => gate); coordinator = createOfflineCoordinator('a', deps);
    const pending = Array.from({ length: 50 }, () => coordinator!.request('reconnect'));
    await tick(0); expect(deps.probe).toHaveBeenCalledOnce(); release(); await Promise.all(pending); await tick();
    expect(deps.prepare).toHaveBeenCalledOnce(); expect(deps.sync).toHaveBeenCalledOnce();
  });
  it('repeated focus/visibility freshness does no visible sync or preload for a fresh snapshot', async () => {
    ready(); coordinator = createOfflineCoordinator('a', deps);
    for (let i = 0; i < 50; i++) await coordinator.request('freshness'); await tick();
    expect(deps.prepare).not.toHaveBeenCalled(); expect(deps.sync).not.toHaveBeenCalled(); expect(meta.status).toBe('ready');
    expect(getOfflineRuntime('a').operations.pipeline).toMatchObject({ kind: 'refresh', visible: false, phase: 'settled' });
  });
  it('partial Extended retries automatically at its deadline despite recent Basic success', async () => {
    ready(); meta.scheme = 'extended'; meta.extended_ready = false; meta.status = 'partial';
    meta.retry = { failures: 1, next_retry_at: Date.now() + 5000, reason: 'optional' };
    coordinator = createOfflineCoordinator('a', deps); await coordinator.request('freshness'); await tick();
    expect(deps.prepare).not.toHaveBeenCalled(); await tick(4650);
    expect(meta.extended_ready).toBe(true); expect(deps.prepare).toHaveBeenCalledOnce();
  });
  it('startup checks sync capabilities immediately even when preparation has a durable backoff', async () => {
    ready(); meta.retry = { failures: 1, next_retry_at: Date.now() + 30_000 }; deps.delay = () => 30_000;
    coordinator = createOfflineCoordinator('a', deps); await coordinator.request('startup'); await tick();
    expect(deps.sync).toHaveBeenCalledWith(true); expect(deps.prepare).not.toHaveBeenCalled();
    expect(getOfflineRuntime('a').operations.pipeline).toMatchObject({ phase: 'settled', outcome: 'partial' });
  });
  it('backs off a first storage-write error even when storage cannot persist retry metadata', async () => {
    deps.prepare = vi.fn().mockImplementationOnce(async () => {
      meta = { ...meta, status: 'error', error: 'Storage quota exceeded', retry: null }; return 'settled' as const;
    }).mockImplementation(async () => { ready(); return 'settled' as const; });
    coordinator = createOfflineCoordinator('a', deps); await coordinator.request('startup'); await tick();
    expect(getOfflineRuntime('a').operations.pipeline?.outcome).toBe('error');
    await tick(1000); expect(deps.prepare).toHaveBeenCalledOnce();
    await tick(4000); expect(deps.prepare).toHaveBeenCalledTimes(2); expect(meta.basic_ready).toBe(true);
  });
  it('dispose/reload invalidates live recovery and late work cannot resurrect it', async () => {
    deps.probe = vi.fn(() => new Promise<void>(() => undefined)); coordinator = createOfflineCoordinator('a', deps);
    const pending = coordinator.request('reconnect'); await tick(0); coordinator.dispose(); await pending;
    expect(getOfflineRuntime('a').operations.pipeline?.phase).toBe('settled'); expect(vi.getTimerCount()).toBe(0);
  });
});
describe('physical network versus backend availability', () => {
  it('navigator online + backend unavailable remains degraded; unrelated success cannot bypass a probe', async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const cleanup = monitorConnectivity(vi.fn(() => gate));
    try {
      reportConnectivityFailure(new TypeError('Failed to fetch')); reportBrowserConnectivity(true); await tick(0);
      reportConnectivitySuccess(); expect(getConnectivityState()).toBe('degraded');
      expect(getNetworkFacts()).toMatchObject({ physical: 'connected', backend: 'unavailable' });
      release(); await tick(0); expect(getConnectivityState()).toBe('online');
    } finally { cleanup(); }
  });
  it('focus/pageshow repairs a missed online event after an offline cold start', async () => {
    const events = new EventTarget(); vi.stubGlobal('window', events); vi.stubGlobal('navigator', { onLine: false });
    const cleanup = monitorConnectivity(vi.fn(async () => undefined));
    try {
      expect(getConnectivityState()).toBe('offline'); vi.stubGlobal('navigator', { onLine: true });
      events.dispatchEvent(new Event('pageshow')); events.dispatchEvent(new Event('focus')); await tick(0);
      expect(getConnectivityState()).toBe('online'); expect(getNetworkFacts().backend).toBe('reachable');
    } finally { cleanup(); }
  });
});
