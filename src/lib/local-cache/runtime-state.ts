import type { BootstrapMetadata } from './bootstrap-types';

// The only owner of volatile offline state. Storage contains facts; workers
// publish facts and operation transitions here; UI adapters only project it.
export type NetworkFacts = {
  physical: 'unknown' | 'connected' | 'disconnected';
  backend: 'unknown' | 'reachable' | 'unavailable';
  checkedAt: number | null;
};
export type OperationSlot = 'preparation' | 'sync' | 'pipeline';
export type OperationKind = 'preparation' | 'synchronization' | 'recovery' | 'refresh';
export type Outcome = 'success' | 'partial' | 'waiting-network' | 'error' | 'cancelled' | 'superseded';
export type RuntimeOperation = {
  id: number; kind: OperationKind; phase: 'running' | 'settled';
  startedAt: number; completedAt: number | null; outcome: Outcome | null;
  visible: boolean; progress: { done: number; total: number } | null; error: string | null;
};
export type OfflineRuntime = {
  epoch: number;
  operations: Partial<Record<OperationSlot, RuntimeOperation>>;
  bootstrap: Pick<BootstrapMetadata, 'user_id' | 'scheme' | 'manifest' | 'datasets' | 'assets_ready' | 'basic_ready'
    | 'extended_ready' | 'offline_ready' | 'completed_at' | 'last_successful_sync_at' | 'verified' | 'retry' | 'error'> | null;
  syncError: string | null;
  queue: { pendingCount: number; unsyncedCount: number; failedCount: number; conflictCount: number; lastSuccessfulSyncAt: string | null; restored: boolean };
};
export type OperationTicket = {
  userId: string; slot: OperationSlot; id: number; epoch: number; signal: AbortSignal;
  current: () => boolean; assertCurrent: () => void;
  update: (patch: Partial<Pick<RuntimeOperation, 'visible' | 'progress'>>) => void;
  finish: (outcome: Outcome, error?: string | null) => void;
};

let network: NetworkFacts = { physical: 'unknown', backend: 'unknown', checkedAt: null };
let sequence = 0;
const accounts = new Map<string, OfflineRuntime>();
const owners = new Map<string, { ticket: OperationTicket; controller: AbortController; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Set<(userId: string | null) => void>();
const keyFor = (userId: string, slot: OperationSlot) => `${userId}:${slot}`;
function emit(userId: string | null): void { for (const fn of listeners) fn(userId); }
export function subscribeOfflineRuntime(fn: (userId: string | null) => void): () => void {
  listeners.add(fn); return () => { listeners.delete(fn); };
}
export function getNetworkFacts(): NetworkFacts { return network; }
export function setNetworkFacts(patch: Partial<NetworkFacts>): void {
  const next = { ...network, ...patch };
  if (JSON.stringify(next) === JSON.stringify(network)) return;
  network = next; emit(null);
}
export function getOfflineRuntime(userId: string): OfflineRuntime {
  let account = accounts.get(userId);
  if (!account) {
    account = { epoch: 0, operations: {}, bootstrap: null, syncError: null,
      queue: { pendingCount: 0, unsyncedCount: 0, failedCount: 0, conflictCount: 0, lastSuccessfulSyncAt: null, restored: false } };
    accounts.set(userId, account);
  }
  return account;
}
export function cancelledOperation(): Error { return Object.assign(new Error('Operation cancelled'), { name: 'AbortError' }); }
export function startRuntimeOperation(userId: string, slot: OperationSlot, kind: OperationKind,
  timeoutMs: number, visible = false): OperationTicket {
  cancelRuntimeOperation(userId, slot, 'superseded');
  const account = getOfflineRuntime(userId);
  const id = ++sequence; const epoch = account.epoch;
  const controller = new AbortController(); const key = keyFor(userId, slot);
  const current = () => !controller.signal.aborted && getOfflineRuntime(userId).epoch === epoch
    && getOfflineRuntime(userId).operations[slot]?.id === id
    && getOfflineRuntime(userId).operations[slot]?.phase === 'running';
  const ticket: OperationTicket = { userId, slot, id, epoch, signal: controller.signal, current,
    assertCurrent: () => { if (!current()) throw cancelledOperation(); },
    update: (patch) => {
      if (!current()) return;
      const value = getOfflineRuntime(userId);
      accounts.set(userId, { ...value, operations: { ...value.operations, [slot]: { ...value.operations[slot]!, ...patch,
        ...(slot === 'sync' && patch.visible ? { kind: 'synchronization' } : {}),
      } } });
      emit(userId);
    },
    finish: (outcome, error = null) => {
      if (!current()) return;
      const value = getOfflineRuntime(userId);
      const owner = owners.get(key); if (owner?.ticket.id === id) { clearTimeout(owner.timer); owners.delete(key); }
      accounts.set(userId, { ...value, operations: { ...value.operations, [slot]: {
        ...value.operations[slot]!, phase: 'settled', completedAt: Date.now(), outcome, progress: null, visible: false, error,
      } } });
      emit(userId);
    },
  };
  accounts.set(userId, { ...account, operations: { ...account.operations, [slot]: {
    id, kind, phase: 'running', startedAt: Date.now(), completedAt: null, outcome: null, visible, progress: null, error: null,
  } } });
  const timer = setTimeout(() => { ticket.finish('error', 'Operation timed out'); controller.abort(); }, timeoutMs);
  if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  owners.set(key, { ticket, controller, timer }); emit(userId);
  return ticket;
}
export function cancelRuntimeOperation(userId: string, slot: OperationSlot, outcome: Outcome = 'cancelled'): void {
  const owner = owners.get(keyFor(userId, slot));
  if (!owner) return;
  owner.ticket.finish(outcome); owner.controller.abort();
}
export function invalidateOfflineRuntime(userId: string): void {
  for (const slot of ['pipeline', 'preparation', 'sync'] as const) cancelRuntimeOperation(userId, slot);
  const value = getOfflineRuntime(userId);
  accounts.set(userId, { ...value, epoch: value.epoch + 1, bootstrap: null, syncError: null, queue: { ...value.queue, restored: false } }); emit(userId);
}
export function publishBootstrapFacts(userId: string, bootstrap: BootstrapMetadata, ticket?: OperationTicket): void {
  if (ticket && !ticket.current()) return;
  const value = getOfflineRuntime(userId);
  accounts.set(userId, { ...value, bootstrap: {
    user_id: bootstrap.user_id, scheme: bootstrap.scheme, manifest: bootstrap.manifest, datasets: bootstrap.datasets,
    assets_ready: bootstrap.assets_ready, basic_ready: bootstrap.basic_ready, extended_ready: bootstrap.extended_ready,
    offline_ready: bootstrap.offline_ready, completed_at: bootstrap.completed_at, last_successful_sync_at: bootstrap.last_successful_sync_at,
    verified: bootstrap.verified, retry: bootstrap.retry, error: bootstrap.error,
  } });
  // Storage announcements wake readers. Avoid recursive I/O from read-back.
}
export function publishSyncError(userId: string, syncError: string | null, ticket?: OperationTicket): void {
  if (ticket && !ticket.current()) return;
  accounts.set(userId, { ...getOfflineRuntime(userId), syncError }); emit(userId);
}
export function publishQueueFacts(userId: string, queue: OfflineRuntime['queue']): void {
  accounts.set(userId, { ...getOfflineRuntime(userId), queue });
}
export function resetOfflineRuntime(): void {
  for (const owner of owners.values()) { clearTimeout(owner.timer); owner.controller.abort(); }
  owners.clear(); accounts.clear(); network = { physical: 'unknown', backend: 'unknown', checkedAt: null };
}
