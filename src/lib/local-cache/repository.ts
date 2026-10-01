import type { TaskItem } from '@/lib/supabase/client';
import { supabase } from '@/lib/supabase/client';
import { ResourceAccessDeniedError } from '@/lib/errors/domain-errors';
import { activeCacheUserId, getCached } from './cache';
import { localCacheDriver } from './driver';
import { applyPendingOperations, listPendingOperations } from './outbox';
import { announceSyncChange, subscribeSyncChanges } from './sync';
import { getSyncState, subscribeSyncState } from './status';
import { performSupportedEdit } from './edit';

export type ChecklistMode = 'active' | 'archived' | 'all';
const refreshes = new Map<string, Promise<TaskItem[]>>();
const key = (taskId: string, mode: ChecklistMode) => `items:${taskId}:${mode}`;

async function ensureUser(userId: string): Promise<void> {
  if (!userId || await activeCacheUserId() !== userId) throw new Error('Сеанс изменился.');
}

export const ChecklistLocalRepository = {
  async getEffectiveTaskItems(userId: string, taskId: string, mode: ChecklistMode): Promise<TaskItem[] | null> {
    await ensureUser(userId);
    if (await getCached<boolean>(userId, `blocked-task:${taskId}`)) throw new ResourceAccessDeniedError('Нет доступа к этапу.');
    const task = await getCached<{ project_id: string }>(userId, `task:${taskId}`);
    if (task && await getCached<boolean>(userId, `blocked:${task.project_id}`)) throw new ResourceAccessDeniedError('Нет доступа к проекту.');
    const confirmed = await getCached<TaskItem[]>(userId, key(taskId, mode));
    if (!confirmed) return null;
    const pending = await listPendingOperations(userId, taskId);
    await ensureUser(userId);
    return applyPendingOperations(confirmed, pending, userId, taskId);
  },
  refreshTaskItems(userId: string, taskId: string, mode: ChecklistMode): Promise<TaskItem[]> {
    const identity = `${userId}:${taskId}:${mode}`;
    const existing = refreshes.get(identity);
    if (existing) return existing;
    const task = (async () => {
      await ensureUser(userId);
      const access = await supabase.from('tasks').select('id').eq('id', taskId).maybeSingle();
      if (access.error) throw access.error;
      if (!access.data) {
        await localCacheDriver.put({ user_id: userId, key: `blocked-task:${taskId}`, data: 'true',
          last_synced_at: new Date().toISOString(), schema_version: 1 });
        throw new ResourceAccessDeniedError('Нет доступа к этапу.');
      }
      const rows: TaskItem[] = [];
      for (let from = 0; ; from += 500) {
        let query = supabase.from('task_items').select('*').eq('task_id', taskId).order('position').order('id').range(from, from + 499);
        if (mode !== 'all') query = query.eq('is_archived', mode === 'archived');
        const { data, error } = await query;
        if (error) throw error;
        rows.push(...(data ?? []));
        if (!data || data.length < 500) break;
      }
      await ensureUser(userId);
      const old = await localCacheDriver.get(userId, key(taskId, mode));
      const serialized = JSON.stringify(rows);
      await localCacheDriver.putIfUnchanged({ user_id: userId, key: key(taskId, mode), data: serialized,
        last_synced_at: new Date().toISOString(), schema_version: 1 }, old?.data ?? null);
      await localCacheDriver.remove(userId, `blocked-task:${taskId}`);
      const effective = await ChecklistLocalRepository.getEffectiveTaskItems(userId, taskId, mode);
      if (old?.data !== serialized) announceSyncChange(userId);
      return effective ?? rows;
    })().finally(() => { refreshes.delete(identity); });
    refreshes.set(identity, task);
    return task;
  },
  subscribe: subscribeSyncChanges,
  subscribeSyncState,
  getSyncState,
  mutate: performSupportedEdit,
};
