import type { OfflineOperation } from './types';
import type { OperationHandle } from '@/lib/supabase/operation-handle';
import { operationContext } from '@/lib/supabase/operation-handle';
import { newOperationId } from './uuid';

/** RFC 9562 application-defined UUIDv8: a permanent legacy namespace fence.
 * Existing IDs are never rewritten. The random bits remain cryptographic. */
export function newAttemptId(): string {
  const id = newOperationId();
  return id.slice(0, 14) + '8' + id.slice(15);
}

export function bindAttempt(row: OfflineOperation, handle: OperationHandle): OfflineOperation {
  if (row.status !== 'pending') throw new Error('Операция изменилась до сохранения идентификатора.');
  if (row.operation_handle) return row;
  operationContext(handle);
  if (row.status !== 'pending' || row.protocol_version !== 3 || handle.id !== row.operation_id
    || !Number.isSafeInteger(row.expected_version) || row.expected_version! < 1 || row.depends_on_operation_id)
    throw new Error('Операция изменилась до сохранения идентификатора.');
  return { ...row, operation_handle: handle, logical_operation_id: row.logical_operation_id ?? row.operation_id };
}

export function assertConflictDiscardable(chain: Pick<OfflineOperation, 'status'>[]) {
  if (chain.some(row => row.status !== 'conflict' && row.status !== 'review'))
    throw new Error('Результат изменения ещё не согласован. Получите актуальное состояние.');
}

/** A durable pending handle may already have committed. Only a confirmed
 * conflict can replace it; the drivers call this inside their write transaction. */
export function rebaseAttempts(chain: OfflineOperation[], version: number) {
  const first = chain.find(row => row.status !== 'synced_unreconciled');
  if (!first || first.status !== 'conflict' || chain.some(row => row.status === 'review'
    || (row.status === 'pending' && row.operation_handle))) return { ids: new Map<string, string>(), operations: chain };
  const ids = new Map(chain.filter(row => row.status === 'conflict' && row.protocol_version === 3
    && row.operation_handle).map(row => [row.operation_id, newAttemptId()]));
  return { ids, operations: chain.map(row => row.status === 'synced_unreconciled' ? row : ({ ...row,
    operation_id: ids.get(row.operation_id) ?? row.operation_id,
    logical_operation_id: row.logical_operation_id ?? row.operation_id,
    operation_handle: ids.has(row.operation_id) ? null : row.operation_handle,
    depends_on_operation_id: row.operation_id === first?.operation_id ? null
      : ids.get(row.depends_on_operation_id ?? '') ?? row.depends_on_operation_id,
    status: 'pending' as const, last_error: null,
    expected_version: row.operation_id === first?.operation_id ? version : row.expected_version,
  })) };
}
