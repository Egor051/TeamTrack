import type { OfflineOperation } from './types';

export type FailedChainGuard = Pick<OfflineOperation, 'operation_id' | 'status'>[];

// Called inside the driver's write transaction, together with cache/outbox edits.
// A retry, ACK or new dependent write must invalidate an earlier cancel request.
export function assertDiscardableChain(chain: FailedChainGuard, expected?: FailedChainGuard): void {
  if (!chain.length) return; // An already completed cancellation is idempotent.
  if (!chain.some((row) => row.status === 'failed')
    || chain.some((row) => row.status !== 'failed' && row.status !== 'pending')
    || (expected && (chain.length !== expected.length || chain.some((row) =>
      !expected.some((old) => old.operation_id === row.operation_id && old.status === row.status))))) {
    throw new Error('Изменения уже отправляются или изменились. Обновите состояние синхронизации.');
  }
}

export function nextPushOperation(operations: OfflineOperation[]): OfflineOperation | undefined {
  return operations.find((row, index) => row.status !== 'failed' && row.status !== 'conflict'
    && !operations.slice(0, index).some((earlier) => earlier.task_item_id === row.task_item_id));
}
