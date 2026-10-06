import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOfflineCoordinator, type CoordinatorDependencies } from '@/lib/local-cache/coordinator';
import { initialBootstrap, type BootstrapMetadata } from '@/lib/local-cache/bootstrap-types';
import { getOfflineRuntime } from '@/lib/local-cache/runtime-state';
import { registerOfflineWork, requestOfflineWork } from '@/lib/local-cache/work-requests';

let meta: BootstrapMetadata;
let local: boolean;
let needed: boolean;
let deps: CoordinatorDependencies;
let coordinator: ReturnType<typeof createOfflineCoordinator>;
let unregister: () => void;
function ready() {
  meta = { ...meta, status: 'ready', basic_ready: true, offline_ready: true, extended_ready: meta.scheme === 'extended',
    retry: null, error: null, last_successful_sync_at: new Date().toISOString() };
}
beforeEach(() => {
  vi.useFakeTimers(); meta = initialBootstrap('a'); local = false; needed = false; ready();
  deps = { local: () => local, probe: vi.fn(async () => undefined), session: vi.fn(async () => true),
    metadata: vi.fn(async () => structuredClone(meta)), syncNeeded: vi.fn(async () => needed),
    sync: vi.fn(async () => { needed = false; return { outcome: 'success' as const, error: null }; }),
    prepare: vi.fn(async () => { ready(); return 'settled' as const; }),
    cancelPreparation: vi.fn(), cancelSync: vi.fn(), delay: (value) => Math.max(0, (value.retry?.next_retry_at ?? 0) - Date.now()), preloadEnabled: true };
  coordinator = createOfflineCoordinator('a', deps);
  unregister = registerOfflineWork('a', (reason) => coordinator.request(reason));
});
afterEach(() => { unregister(); coordinator.dispose(); vi.useRealTimers(); });
describe('manual-refresh command', () => {
  it('returns completion of the registered command and skips healthy fresh sync/preload/probe', async () => {
    expect(await requestOfflineWork('a', 'manual-refresh')).toMatchObject({ outcome: 'success', sync: null, preparation: 'skipped' });
    expect(deps.sync).not.toHaveBeenCalled(); expect(deps.prepare).not.toHaveBeenCalled(); expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.cancelSync).not.toHaveBeenCalled(); expect(deps.cancelPreparation).not.toHaveBeenCalled();
  });
  it('50 refreshes join a live preparation; successful completion needs no second download', async () => {
    meta = initialBootstrap('a');
    let release!: () => void;
    deps.prepare = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); ready(); return 'settled' as const; });
    const automatic = coordinator.request('reconnect'); await vi.advanceTimersByTimeAsync(0);
    const requests = Array.from({ length: 50 }, () => requestOfflineWork('a', 'manual-refresh'));
    expect(new Set(requests).size).toBe(1);
    expect(deps.prepare).toHaveBeenCalledOnce(); expect(deps.cancelPreparation).not.toHaveBeenCalled();
    release(); await automatic; await Promise.all(requests);
    expect(deps.prepare).toHaveBeenCalledOnce(); expect(deps.sync).toHaveBeenCalledOnce();
  });
  it('syncs pending work without force preparing an already fresh cache', async () => {
    needed = true;
    expect(await coordinator.request('manual-refresh')).toMatchObject({ outcome: 'success', sync: { outcome: 'success' }, preparation: 'skipped' });
    expect(deps.sync).toHaveBeenCalledWith(true); expect(deps.prepare).not.toHaveBeenCalled();
  });
  it.each(['blocked', 'partial'] as const)('retains sync %s independently of ready preparation', async (outcome) => {
    needed = true; deps.sync = vi.fn(async () => ({ outcome, error: 'Sync remains unresolved' }));
    const result = await coordinator.request('manual-refresh');
    expect(result).toMatchObject({ outcome: 'partial', sync: { outcome }, error: 'Sync remains unresolved' });
    expect(getOfflineRuntime('a').operations.pipeline?.outcome).toBe('partial');
    expect(deps.prepare).not.toHaveBeenCalled();
  });
  it('does not report successful refresh when pending changes remain behind a disabled sync', async () => {
    needed = true; deps.sync = vi.fn(async () => ({ outcome: 'disabled' as const, error: null }));
    expect(await coordinator.request('manual-refresh')).toMatchObject({ outcome: 'partial', sync: { outcome: 'disabled' } });
    expect(deps.prepare).not.toHaveBeenCalled();
  });
  it('can prepare an empty account when sync is disabled by the build', async () => {
    meta = initialBootstrap('a'); deps.sync = vi.fn(async () => ({ outcome: 'disabled' as const, error: null }));
    expect(await coordinator.request('manual-refresh')).toMatchObject({ outcome: 'success', preparation: 'ready' });
  });
  it('retries incomplete Extended, retains Basic and bypasses its own retry backoff', async () => {
    meta.scheme = 'extended'; meta.extended_ready = false; meta.retry = { failures: 1, next_retry_at: Date.now() + 300_000 };
    expect(await coordinator.request('manual-refresh')).toMatchObject({ outcome: 'success', preparation: 'ready' });
    expect(deps.prepare).toHaveBeenCalledWith('retry', true);
  });
  it('checks degraded connectivity, and recovers without cancelling workers', async () => {
    local = true; needed = true; deps.probe = vi.fn(async () => { local = false; });
    await coordinator.request('manual-refresh');
    expect(deps.probe).toHaveBeenCalledWith(true); expect(deps.sync).toHaveBeenCalledOnce();
    expect(deps.cancelSync).not.toHaveBeenCalled();
  });
  it('settles offline without sending any changes', async () => {
    local = true; needed = true;
    expect(await coordinator.request('manual-refresh')).toMatchObject({ outcome: 'waiting-network' });
    expect(deps.sync).not.toHaveBeenCalled();
  });
  it('does not lose a data invalidation queued while joining live work', async () => {
    needed = true; let release!: () => void;
    deps.sync = vi.fn(async () => ({ outcome: 'success' as const, error: null })).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; }); needed = false; return { outcome: 'success' as const, error: null };
    });
    const first = coordinator.request('manual-refresh'); await vi.advanceTimersByTimeAsync(0);
    void coordinator.request('invalidation');
    release(); await first; await vi.advanceTimersByTimeAsync(31_000);
    expect(deps.prepare).toHaveBeenCalled();
  });
  it('account disposal cannot resurrect joined work after late completion', async () => {
    needed = true; let release!: () => void;
    deps.sync = vi.fn(async () => { await new Promise<void>((resolve) => { release = resolve; }); return { outcome: 'success' as const, error: null }; });
    const pending = coordinator.request('manual-refresh'); await vi.advanceTimersByTimeAsync(0);
    coordinator.dispose(); release();
    expect((await pending).outcome).toBe('cancelled'); expect(deps.prepare).not.toHaveBeenCalled();
  });
});
