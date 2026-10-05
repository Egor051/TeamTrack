import { boundedOperation } from '@/lib/connectivity/deadline';
import type { BootstrapMetadata } from './bootstrap-types';
import { cancelRuntimeOperation, getOfflineRuntime, invalidateOfflineRuntime, startRuntimeOperation, type OperationTicket } from './runtime-state';
import type { OfflineWorkReason, OfflineWorkResult, SyncResult } from './work-requests';

export type CoordinatorDependencies = {
  local: () => boolean;
  probe: (restart: boolean) => Promise<void>;
  session: () => Promise<boolean>;
  metadata: () => Promise<BootstrapMetadata>;
  prepare: (mode: 'normal' | 'resume' | 'retry', force: boolean) => Promise<'settled' | 'busy'>;
  sync: (force: boolean) => Promise<SyncResult | void>;
  syncNeeded?: () => Promise<boolean>;
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
  let running: { ticket: OperationTicket; promise: Promise<OfflineWorkResult> } | null = null;
  let manualRefresh: Promise<OfflineWorkResult> | null = null;
  let queued: OfflineWorkReason | null = null;
  let mutationsRequested = 0;
  let mutationsSynced = 0;
  let invalidationsRequested = 0;
  let invalidationsPrepared = 0;
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
  const resultFor = (outcome: OfflineWorkResult['outcome']): OfflineWorkResult => ({ outcome, sync: null, preparation: 'skipped', error: null });
  const run = (reason: OfflineWorkReason): Promise<OfflineWorkResult> => {
    if (disposed) return Promise.resolve(resultFor('cancelled'));
    if (running) {
      // Browser event bursts are redundant. Actual data/mutation changes queue
      // at most one additional pass after the current pass has settled.
      if (reason === 'invalidation' || reason === 'mutations' || reason === 'scheme') queued = reason;
      return running.promise;
    }
    const recovery = reason === 'startup' || reason === 'reconnect' || reason === 'retry' || reason === 'scheme';
    const ticket = startRuntimeOperation(userId, 'pipeline', recovery ? 'recovery' : 'refresh', 15 * 60_000);
    const result = resultFor('success');
    const finish = (outcome: Exclude<OfflineWorkResult['outcome'], 'scheduled'>, error: string | null = null) => {
      result.outcome = outcome; result.error = error; ticket.finish(outcome, error);
    };
    ticket.signal.addEventListener('abort', () => {
      if (getOfflineRuntime(userId).operations.pipeline?.id === ticket.id) { deps.cancelPreparation(); deps.cancelSync(); }
    }, { once: true });
    const work = async () => {
      const wait = <T,>(fn: () => PromiseLike<T>, timeout = 45_000) => boundedOperation(fn, timeout, ticket.signal)
        .then((value) => { ticket.assertCurrent(); return value; });
      const refresh = reason === 'manual-refresh';
      if (recovery || deps.local()) await wait(() => deps.probe(reason === 'retry' || refresh));
      if (deps.local()) {
        if (deps.preloadEnabled) {
          const meta = await wait(deps.metadata);
          if (!(meta.scheme === 'basic' ? meta.basic_ready : meta.extended_ready)) {
            await wait(() => deps.prepare('normal', false), 10 * 60_000);
            result.preparation = 'partial';
          }
        }
        finish('waiting-network'); return;
      }
      if (!await wait(deps.session)) {
        finish('error', 'Требуется авторизация.');
        schedule('freshness', Math.min(300_000, 5000 * 2 ** Math.min(retryFailures++, 6))); return;
      }
      let meta = deps.preloadEnabled ? await wait(deps.metadata) : null;
      const transportRecovery = meta?.status === 'offline_waiting' || meta?.retry?.reason === 'transport';
      const manual = reason === 'retry' || reason === 'scheme' || refresh;
      const stale = !meta?.last_successful_sync_at || Date.now() - Date.parse(meta.last_successful_sync_at) >= deps.refreshMs;
      const selectedReady = meta && (meta.scheme === 'basic' ? meta.basic_ready : meta.extended_ready);
      const invalidated = invalidationsRequested > invalidationsPrepared;
      const due = deps.preloadEnabled && (!meta || !selectedReady || !!meta.retry || stale || invalidated || reason === 'invalidation' || transportRecovery);
      // Push/pull/reconciliation first. Preparation then snapshots confirmed
      // server data without rolling back the outbox or newer pulled versions.
      // A preparation lease/backoff must not postpone capability checks or
      // replay of pending edits after startup/reconnect.
      const syncDemand = reason === 'mutations' || mutationsRequested > mutationsSynced || !!(deps.syncNeeded && await wait(deps.syncNeeded));
      if (due || recovery || syncDemand) {
        const generation = mutationsRequested;
        result.sync = await wait(() => deps.sync(recovery || refresh), 5 * 60_000) ?? { outcome: 'success', error: null };
        mutationsSynced = generation;
      }
      const syncIncomplete = result.sync && result.sync.outcome !== 'success' && (result.sync.outcome !== 'disabled' || syncDemand);
      if (meta && due) {
        const delay = manual || transportRecovery ? 0 : deps.delay(meta);
        if (delay > 0) { result.preparation = 'partial'; schedule(reason, delay + 50); finish('partial'); return; }
        const generation = invalidationsRequested;
        const prepared = await wait(() => deps.prepare(manual ? 'retry' : transportRecovery ? 'resume' : 'normal',
          recovery || refresh || invalidated || reason === 'invalidation'), 10 * 60_000);
        if (prepared === 'busy') { result.preparation = 'busy'; schedule('freshness', 1000); finish('partial'); return; }
        invalidationsPrepared = generation;
        meta = await wait(deps.metadata);
        const ready = meta.scheme === 'basic' ? meta.basic_ready : meta.extended_ready;
        result.preparation = ready ? 'ready' : 'partial';
        if (!ready || meta.retry) schedule('freshness', Math.max(1000, deps.delay(meta) + 50,
          !ready && meta.error && !meta.retry ? Math.min(300_000, 5000 * 2 ** Math.min(retryFailures++, 6)) : 0));
        else retryFailures = 0;
        finish(!ready ? deps.local() ? 'waiting-network' : meta.error ? 'error' : 'partial'
          : syncIncomplete ? 'partial' : 'success', meta.error ?? result.sync?.error);
      } else {
        finish(syncIncomplete ? 'partial' : 'success', result.sync?.error);
        retryFailures = 0;
      }
    };
    const promise = boundedOperation(work, 15 * 60_000, ticket.signal).catch((error: unknown) => {
      if (!ticket.current()) {
        const operation = getOfflineRuntime(userId).operations.pipeline;
        result.outcome = operation?.id === ticket.id && operation.outcome === 'error' ? 'error' : 'cancelled';
        result.error = result.outcome === 'error' ? operation?.error ?? null : null;
        return;
      }
      finish(deps.local() ? 'waiting-network' : 'error', error instanceof Error ? error.message : 'Recovery failed');
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
    }).then(() => result);
    running = { ticket, promise }; return promise;
  };
  return {
    request(reason: OfflineWorkReason): Promise<OfflineWorkResult> {
      if (disposed) return Promise.resolve(resultFor('cancelled'));
      // Mutation demand is independent of preparation/backoff scheduling.
      // An edit arriving during an await requires a later sync even if another
      // tab has made the account snapshot fresh by then.
      if (reason === 'mutations') mutationsRequested += 1;
      if (reason === 'invalidation') invalidationsRequested += 1;
      if (reason === 'manual-refresh') {
        if (manualRefresh) return manualRefresh;
        clearTimer();
        // Join live work, then re-plan against its committed result. Never
        // abort healthy sync/preparation just because a user pressed Refresh.
        const active = running?.promise;
        const task = (active ? active.then(() => { clearTimer(); queued = null; return run(reason); }) : run(reason)).finally(() => {
          if (manualRefresh === task) manualRefresh = null;
        });
        manualRefresh = task; return task;
      }
      if (reason === 'retry' || reason === 'scheme') { clearTimer(); queued = null; cancel(); return run(reason); }
      if (reason === 'reconnect') { if (running) return run(reason); clearTimer(); queued = null; return run(reason); }
      if (running) return run(reason);
      // Do not postpone an existing durable backoff on foreground bursts.
      if (!timer) schedule(reason);
      else if (reason === 'invalidation' || reason === 'mutations') queued = reason;
      return Promise.resolve(resultFor('scheduled'));
    },
    networkLost() { clearTimer(); queued = null; cancel(); schedule('freshness'); },
    dispose() { disposed = true; clearTimer(); queued = null; cancel(); invalidateOfflineRuntime(userId); },
  };
}
