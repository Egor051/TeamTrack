import { boundedOperation } from '@/lib/connectivity/deadline';
import type { BootstrapMetadata } from './bootstrap-types';
import { cancelRuntimeOperation, getOfflineRuntime, invalidateOfflineRuntime, startRuntimeOperation, type OperationTicket } from './runtime-state';
import type { OfflineWorkReason } from './work-requests';

export type CoordinatorDependencies = {
  local: () => boolean;
  probe: (restart: boolean) => Promise<void>;
  session: () => Promise<boolean>;
  metadata: () => Promise<BootstrapMetadata>;
  prepare: (mode: 'normal' | 'resume' | 'retry', force: boolean) => Promise<'settled' | 'busy'>;
  sync: (force: boolean) => Promise<void>;
  cancelPreparation: () => void;
  cancelSync: () => void;
  delay: (meta: BootstrapMetadata) => number;
  refreshMs: number;
  preloadEnabled: boolean;
};

// One event scheduler and recovery lifecycle per account. Workers retain their
// cross-tab locks/CAS, but never own browser reconnect/foreground listeners.
export function createOfflineCoordinator(userId: string, deps: CoordinatorDependencies) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: { ticket: OperationTicket; promise: Promise<void> } | null = null;
  let queued: OfflineWorkReason | null = null;
  let retryFailures = 0;
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; };
  const schedule = (reason: OfflineWorkReason, delay = 400) => {
    if (disposed) return;
    queued = reason; clearTimer();
    timer = setTimeout(() => { timer = null; const next = queued!; queued = null; void run(next); }, delay);
  };
  const cancel = () => {
    cancelRuntimeOperation(userId, 'pipeline');
    deps.cancelPreparation(); deps.cancelSync(); running = null;
  };
  const run = (reason: OfflineWorkReason): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (running) {
      // Browser event bursts are redundant. Actual data/mutation changes queue
      // at most one additional pass after the current pass has settled.
      if (reason === 'invalidation' || reason === 'mutations' || reason === 'scheme') queued = reason;
      return running.promise;
    }
    const recovery = reason === 'startup' || reason === 'reconnect' || reason === 'retry' || reason === 'scheme';
    const ticket = startRuntimeOperation(userId, 'pipeline', recovery ? 'recovery' : 'refresh', 15 * 60_000);
    ticket.signal.addEventListener('abort', () => {
      if (getOfflineRuntime(userId).operations.pipeline?.id === ticket.id) { deps.cancelPreparation(); deps.cancelSync(); }
    }, { once: true });
    const work = async () => {
      const wait = <T,>(fn: () => PromiseLike<T>, timeout = 45_000) => boundedOperation(fn, timeout, ticket.signal)
        .then((value) => { ticket.assertCurrent(); return value; });
      if (recovery || deps.local()) await wait(() => deps.probe(reason === 'retry'));
      if (deps.local()) {
        if (deps.preloadEnabled) await wait(() => deps.prepare('normal', false), 10 * 60_000);
        ticket.finish('waiting-network'); return;
      }
      if (!await wait(deps.session)) {
        ticket.finish('error', 'Требуется авторизация.');
        schedule('freshness', Math.min(300_000, 5000 * 2 ** Math.min(retryFailures++, 6))); return;
      }
      let meta = deps.preloadEnabled ? await wait(deps.metadata) : null;
      const transportRecovery = meta?.status === 'offline_waiting' || meta?.retry?.reason === 'transport';
      const manual = reason === 'retry' || reason === 'scheme';
      const stale = !meta?.last_successful_sync_at || Date.now() - Date.parse(meta.last_successful_sync_at) >= deps.refreshMs;
      const selectedReady = meta && (meta.scheme === 'basic' ? meta.basic_ready : meta.extended_ready);
      const due = !meta || !selectedReady || !!meta.retry || stale || reason === 'invalidation' || recovery || transportRecovery;
      // Push/pull/reconciliation first. Preparation then snapshots confirmed
      // server data without rolling back the outbox or newer pulled versions.
      // A preparation lease/backoff must not postpone capability checks or
      // replay of pending edits after startup/reconnect.
      if (due || reason === 'mutations') await wait(() => deps.sync(recovery), 5 * 60_000);
      if (meta && due) {
        const delay = manual || transportRecovery ? 0 : deps.delay(meta);
        if (delay > 0) { schedule(reason, delay + 50); ticket.finish('partial'); return; }
        const result = await wait(() => deps.prepare(manual ? 'retry' : transportRecovery ? 'resume' : 'normal',
          recovery || reason === 'invalidation'), 10 * 60_000);
        if (result === 'busy') { schedule(reason, 1000); ticket.finish('partial'); return; }
        meta = await wait(deps.metadata);
        const ready = meta.scheme === 'basic' ? meta.basic_ready : meta.extended_ready;
        if (!ready || meta.retry) schedule('freshness', Math.max(1000, deps.delay(meta) + 50,
          !ready && meta.error && !meta.retry ? Math.min(300_000, 5000 * 2 ** Math.min(retryFailures++, 6)) : 0));
        else retryFailures = 0;
        ticket.finish(ready ? 'success' : deps.local() ? 'waiting-network' : meta.error ? 'error' : 'partial', meta.error);
      } else { ticket.finish('success'); retryFailures = 0; }
    };
    const promise = boundedOperation(work, 15 * 60_000, ticket.signal).catch((error: unknown) => {
      if (!ticket.current()) return;
      ticket.finish(deps.local() ? 'waiting-network' : 'error', error instanceof Error ? error.message : 'Recovery failed');
      // A defined error outcome plus backoff, never a synthetic ready reset.
      schedule('freshness', Math.min(300_000, 5000 * 2 ** Math.min(retryFailures++, 6)));
    }).finally(() => {
      ticket.finish('partial');
      if (running?.ticket !== ticket) return;
      running = null;
      const operation = getOfflineRuntime(userId).operations.pipeline;
      if (!disposed && ticket.signal.aborted && operation?.id === ticket.id && operation.outcome === 'error') {
        schedule('mutations', Math.min(300_000, 5000 * 2 ** Math.min(retryFailures++, 6))); return;
      }
      if (!disposed && queued && !timer) schedule(queued);
    });
    running = { ticket, promise }; return promise;
  };
  return {
    request(reason: OfflineWorkReason): Promise<void> {
      if (disposed) return Promise.resolve();
      if (reason === 'retry' || reason === 'scheme') { clearTimer(); queued = null; cancel(); return run(reason); }
      if (reason === 'reconnect') { if (running) return run(reason); clearTimer(); queued = null; return run(reason); }
      if (running) return run(reason);
      // Do not postpone an existing durable backoff on foreground bursts.
      if (!timer) schedule(reason);
      else if (reason === 'invalidation' || reason === 'mutations') queued = reason;
      return Promise.resolve();
    },
    networkLost() { clearTimer(); queued = null; cancel(); schedule('freshness'); },
    dispose() { disposed = true; clearTimer(); queued = null; cancel(); invalidateOfflineRuntime(userId); },
  };
}
