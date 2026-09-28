import { activeCacheUserId, isTransportFailure } from './cache';
import { enqueueOperation, hasPendingOperations, offlineWriteEnabled, type SupportedEdit } from './outbox';
import type { OfflineOperation } from './types';

export async function performSupportedEdit(input: {
  userId: string;
  projectId: string;
  taskId: string;
  itemId: string;
  offline: boolean;
  edit: SupportedEdit;
  onlineAction: () => Promise<unknown>;
}): Promise<{ kind: 'server' } | { kind: 'local'; operation: OfflineOperation }> {
  if (await activeCacheUserId() !== input.userId) throw new Error('Требуется авторизация.');
  const enabled = offlineWriteEnabled();
  const dirty = enabled && await hasPendingOperations(input.userId, input.taskId, input.itemId);
  if (!enabled || (!input.offline && !dirty)) {
    try {
      await input.onlineAction();
      return { kind: 'server' };
    } catch (error) {
      if (!enabled || !isTransportFailure(error)) throw error;
    }
  }
  const operation = await enqueueOperation(input.userId, input.projectId, input.taskId, input.itemId, input.edit);
  return { kind: 'local', operation };
}
