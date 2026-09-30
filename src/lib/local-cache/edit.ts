import { activeCacheUserId } from './cache';
import { enqueueOperation, hasPendingOperations, type SupportedEdit } from './outbox';
import type { OfflineOperation } from './types';
import { runtimeCapabilities } from './runtime-config';
import { syncPendingOperations, announceSyncChange } from './sync';

export async function performSupportedEdit(input: {
  userId: string;
  projectId: string;
  taskId: string;
  itemId: string;
  itemVersion?: number;
  offline: boolean;
  edit: SupportedEdit;
  onlineAction: () => Promise<unknown>;
}): Promise<{ kind: 'server' } | { kind: 'local'; operation: OfflineOperation }> {
  if (await activeCacheUserId() !== input.userId) throw new Error('Требуется авторизация.');
  const enabled = (await runtimeCapabilities(input.userId)).write;
  const dirty = await hasPendingOperations(input.userId, input.taskId, input.itemId);
  if (dirty && !enabled) throw new Error('Новые локальные изменения временно отключены. Сохранённые изменения остаются на устройстве.');
  if (!enabled) {
    if (input.offline) throw new Error('Офлайн-редактирование временно отключено.');
    await input.onlineAction();
    return { kind: 'server' };
  }
  const operation = await enqueueOperation(input.userId, input.projectId, input.taskId, input.itemId, input.edit, input.itemVersion);
  announceSyncChange(input.userId);
  void syncPendingOperations(input.userId).catch(() => undefined);
  return { kind: 'local', operation };
}
