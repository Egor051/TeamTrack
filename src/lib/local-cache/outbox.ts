import type { TaskItem } from '@/lib/supabase/client';
import { activeCacheUserId } from './cache';
import { localCacheDriver } from './driver';
import type { OfflineOperation, OfflineOperationInput } from './types';
import { newOperationId } from './uuid';
import { validSyncVersion } from './pull-cache';

export function offlineWriteEnabled(): boolean {
  return process.env.EXPO_PUBLIC_OFFLINE_WRITE_ENABLED === 'true';
}

export function offlineSyncEnabled(): boolean {
  return process.env.EXPO_PUBLIC_OFFLINE_SYNC_ENABLED === 'true';
}

export type SupportedEdit =
  | { type: 'set_task_item_state'; payload: { completed: boolean } }
  | { type: 'set_task_item_percentage'; payload: { percentage: number } }
  | { type: 'set_task_item_comment'; payload: { comment: string | null } };

function validateEdit(edit: SupportedEdit): SupportedEdit {
  if (edit.type === 'set_task_item_state') {
    if (typeof edit.payload.completed !== 'boolean') throw new Error('Некорректное состояние пункта.');
  } else if (edit.type === 'set_task_item_percentage') {
    const value = edit.payload.percentage;
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('Процент должен быть целым числом от 0 до 100.');
  } else {
    const comment = edit.payload.comment;
    if (comment !== null && typeof comment !== 'string') throw new Error('Некорректный комментарий.');
    if (comment && comment.length > 10000) throw new Error('Комментарий слишком длинный (максимум 10000 символов).');
    return { type: edit.type, payload: { comment: comment?.trim() || null } };
  }
  return edit;
}

export async function enqueueOperation(
  userId: string,
  projectId: string,
  taskId: string,
  itemId: string,
  edit: SupportedEdit,
  displayedVersion?: number,
): Promise<OfflineOperation> {
  if (!offlineWriteEnabled()) throw new Error('Офлайн-редактирование отключено.');
  if (!userId || await activeCacheUserId() !== userId) throw new Error('Требуется авторизация.');
  const checked = validateEdit(edit);
  const operation: OfflineOperationInput = {
    operation_id: newOperationId(), user_id: userId, project_id: projectId,
    task_id: taskId, task_item_id: itemId, ...checked,
    created_at: new Date().toISOString(), status: 'pending',
    expected_version: validSyncVersion(displayedVersion) ? displayedVersion : null,
  };
  const saved = await localCacheDriver.enqueue(operation);
  if (await activeCacheUserId() !== userId) throw new Error('Сеанс изменился. Обновите страницу.');
  return saved;
}

export async function listPendingOperations(userId: string, taskId?: string): Promise<OfflineOperation[]> {
  if (!userId || await activeCacheUserId() !== userId) return [];
  const operations = await localCacheDriver.listPending(userId, taskId);
  if (await activeCacheUserId() !== userId) return [];
  return operations.filter((operation) => operation.user_id === userId && (!taskId || operation.task_id === taskId))
    .sort((a, b) => a.sequence - b.sequence);
}

export async function listPendingOperationsForItem(userId: string, taskId: string, itemId: string): Promise<OfflineOperation[]> {
  return (await listPendingOperations(userId, taskId)).filter((operation) => operation.task_item_id === itemId);
}

export async function hasPendingOperations(userId: string, taskId: string, itemId: string): Promise<boolean> {
  return (await listPendingOperationsForItem(userId, taskId, itemId)).length > 0;
}

export function applyPendingOperations<T extends Pick<TaskItem, 'id' | 'percentage' | 'is_completed' | 'comment'>>(
  confirmed: T[], operations: OfflineOperation[], userId: string, taskId: string,
): T[] {
  const latest = new Map(confirmed.map((item) => [item.id, { ...item }]));
  for (const operation of [...operations].sort((a, b) => a.sequence - b.sequence)) {
    if (operation.user_id !== userId || operation.task_id !== taskId) continue;
    const item = latest.get(operation.task_item_id);
    if (!item) continue;
    if (operation.type === 'set_task_item_state') {
      const completed = (operation.payload as { completed: boolean }).completed;
      item.is_completed = completed;
      item.percentage = completed ? 100 : 0;
    } else if (operation.type === 'set_task_item_percentage') {
      const percentage = (operation.payload as { percentage: number }).percentage;
      item.percentage = percentage;
      item.is_completed = percentage === 100;
    } else {
      item.comment = (operation.payload as { comment: string | null }).comment;
    }
  }
  return confirmed.map((item) => latest.get(item.id)!);
}
