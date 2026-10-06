import { boundedOperation } from '@/lib/connectivity/deadline';
import type { BootstrapMetadata } from './bootstrap-types';
import { cancelRuntimeOperation, getOfflineRuntime, invalidateOfflineRuntime, startRuntimeOperation, type OperationTicket } from './runtime-state';
import type { OfflineWorkReason, OfflineWorkResult, SyncResult } from './work-requests';

export const OFFLINE_TICK_MS = 20_000;
const FOREGROUND_RECHECK_MS = 5 * 60_000;

export type CoordinatorDependencies = {
  local: () => boolean;
  probe: (restart: boolean) => Promise<void>;
  session: () => Promise<boolean>;
  metadata: () => Promise<BootstrapMetadata>;
  prepare: (mode: 'normal' | 'resume' | 'retry', force: boolean) => Promise<'settled' | 'busy'>;
  sync: (force: boolean) => Promise<SyncResult | void>;
  syncNeeded?: () => Promise<boolean>;
  syncDelay?: () => number;
  foreground?: () => boolean;
  cancelPreparation: () => void;
  cancelSync: () => void;
  delay: (meta: BootstrapMetadata) => number;
  preloadEnabled: boolean;
};

// One event scheduler and recovery lifecycle per account. Workers retain their
// cross-tab locks/CAS, but never own browser reconnect/foreground listeners.
export function createOfflineCoordinator(userId: string, deps: CoordinatorDependencies) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerAt = Infinity;
  let running: { ticket: OperationTicket; promise: Promise<OfflineWorkResult> } | null = null;
  let manualRefresh: Promise<OfflineWorkResult> | null = null;
  let queued: OfflineWorkReason | null = null;
  let mutationsRequested = 0;
  let mutationsSynced = 0;
  let invalidationsRequested = 0;
  let invalidationsPrepared = 0;
  let retryFailures = 0;
  let recoveryUntil = 0;
  let sessionUntil = 0;
  let syncRetryAt: number | null = null;
  let lastSyncCheckAt: number | null = null;
  const clearTimer = () => { if (timer) clearTimeout(timer); timer = null; timerAt = Infinity; };
  const schedule = (reason: OfflineWorkReason, delay = 400) => {
    if (disposed) return;
    const at = Date.now() + delay;
    if (timer && timerAt <= at) return;
    queued = reason; clearTimer(); timerAt = at;
    timer = setTimeout(() => {
      timer = null; timerAt = Infinity;
      const next = queued!; queued = null;
      if (deps.foreground?.() === false) { schedule('tick', OFFLINE_TICK_MS); return; }
      void run(next);
    }, delay);
  };
  const backoff = () => Math.min(300_000, 5000 * 2 ** Math.min(retryFailures++, 6));
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
      if (recovery || (deps.local() && (reason === 'freshness' || refresh))) await wait(() => deps.probe(reason === 'retry' || refresh));
      if (deps.local()) {
        if (deps.preloadEnabled) {
          const meta = await wait(deps.metadata);
          if (recovery && !(meta.scheme === 'basic' ? meta.basic_ready : meta.extended_ready)) {
            await wait(() => deps.prepare('normal', false), 10 * 60_000);
            result.preparation = 'partial';
          }
        }
        finish('waiting-network'); return;
      }
      let meta = deps.preloadEnabled ? await wait(deps.metadata) : null;
      const transportRecovery = meta?.status === 'offline_waiting' || meta?.retry?.reason === 'transport';
      const manual = reason === 'retry' || reason === 'scheme' || refresh;
      const selectedReady = meta && (meta.scheme === 'basic' ? meta.basic_ready : meta.extended_ready);
      const invalidated = invalidationsRequested > invalidationsPrepared;
      // Readiness verifies the real local snapshot (including the current day).
      // Snapshot age alone never causes an unchanged full cache to reload.
      const due = deps.preloadEnabled && (!selectedReady || !!meta?.retry || invalidated || transportRecovery);
      const resumeTransport = transportRecovery && reason === 'reconnect';
      const syncGeneration = mutationsRequested;
      const preparationDelay = !due || manual || resumeTransport ? 0 : Math.max(meta ? deps.delay(meta) : 0, recoveryUntil - Date.now());
      // Push/pull/reconciliation first. Preparation then snapshots confirmed
      // server data without rolling back the outbox or newer pulled versions.
      // A preparation lease/backoff must not postpone capability checks or
      // replay of pending edits after startup/reconnect.
      const syncDemand = mutationsRequested > mutationsSynced || (syncRetryAt !== null && syncRetryAt <= Date.now())
        || !!(deps.syncNeeded && await wait(deps.syncNeeded));
      const foregroundStale = reason === 'freshness' && Date.now()
        - (lastSyncCheckAt ?? Date.parse(meta?.last_successful_sync_at ?? new Date().toISOString())) >= FOREGROUND_RECHECK_MS;
      const syncDue = (syncDemand || recovery || foregroundStale || (due && preparationDelay <= 0))
        && (recovery || refresh || (deps.syncDelay?.() ?? 0) <= 0);
      if (!syncDue && (!due || preparationDelay > 0)) {
        if (due) schedule('freshness', preparationDelay + 50);
        finish(due ? 'partial' : 'success'); return;
      }
      if (!manual && !recovery && sessionUntil > Date.now()) { finish('partial'); schedule('freshness', sessionUntil - Date.now()); return; }
      if (!await wait(deps.session)) {
        sessionUntil = Date.now() + backoff();
        finish('error', 'Требуется авторизация.'); schedule('freshness', sessionUntil - Date.now()); return;
      }
      sessionUntil = 0;
      if (syncDue) {
        syncRetryAt = null;
        result.sync = await wait(() => deps.sync(recovery || refresh), 5 * 60_000) ?? { outcome: 'success', error: null };
        lastSyncCheckAt = Date.now();
        mutationsSynced = syncGeneration;
      }
      const syncIncomplete = result.sync && result.sync.outcome !== 'success' && (result.sync.outcome !== 'disabled' || syncDemand);
      if (meta && due) {
        const delay = preparationDelay;
        if (delay > 0) { result.preparation = 'partial'; schedule(reason, delay + 50); finish('partial'); return; }
        const generation = invalidationsRequested;
        const prepared = await wait(() => deps.prepare(manual ? 'retry' : resumeTransport ? 'resume' : 'normal',
          recovery || refresh || invalidated), 10 * 60_000);
        if (prepared === 'busy') {
          recoveryUntil = Date.now() + Math.max(deps.delay(meta), backoff());
          result.preparation = 'busy'; schedule('freshness', recoveryUntil - Date.now()); finish('partial'); return;
        }
        invalidationsPrepared = generation;
        meta = await wait(deps.metadata);
        const ready = meta.scheme === 'basic' ? meta.basic_ready : meta.extended_ready;
        result.preparation = ready ? 'ready' : 'partial';
        if (!ready || meta.retry) {
          recoveryUntil = Date.now() + Math.max(1000, deps.delay(meta), !meta.retry ? backoff() : 0);
          schedule('freshness', recoveryUntil - Date.now() + (meta.retry ? 50 : 0));
        } else { retryFailures = 0; recoveryUntil = 0; }
        finish(!ready ? deps.local() ? 'waiting-network' : meta.error ? 'error' : 'partial'
          : syncIncomplete ? 'partial' : 'success', meta.error ?? result.sync?.error);
      } else {
        finish(syncIncomplete ? 'partial' : 'success', result.sync?.error);
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
      recoveryUntil = Date.now() + backoff();
      schedule('freshness', recoveryUntil - Date.now());
    }).finally(() => {
      ticket.finish('partial');
      if (running?.ticket !== ticket) return;
      running = null;
      const operation = getOfflineRuntime(userId).operations.pipeline;
      if (!disposed && ticket.signal.aborted && operation?.id === ticket.id && operation.outcome === 'error') {
        recoveryUntil = Date.now() + backoff(); schedule('mutations', recoveryUntil - Date.now()); return;
      }
      if (!disposed && queued && !timer) schedule(queued);
      if (mutationsRequested > mutationsSynced && !deps.local() && result.outcome !== 'error')
        schedule('mutations', Math.max(400, deps.syncDelay?.() ?? 0, sessionUntil - Date.now()));
      schedule('tick', OFFLINE_TICK_MS);
    }).then(() => result);
    running = { ticket, promise }; return promise;
  };
  return {
    request(reason: OfflineWorkReason, delayMs?: number): Promise<OfflineWorkResult> {
      if (disposed) return Promise.resolve(resultFor('cancelled'));
      if (reason === 'sync-retry') {
        syncRetryAt = Date.now() + (delayMs ?? 0);
        schedule('tick', Math.max(25, delayMs ?? 0));
        return Promise.resolve(resultFor('scheduled'));
      }
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
      schedule(reason);
      return Promise.resolve(resultFor('scheduled'));
    },
    networkLost() { clearTimer(); queued = null; cancel(); schedule('freshness'); },
    dispose() { disposed = true; clearTimer(); queued = null; cancel(); invalidateOfflineRuntime(userId); },
  };
}
