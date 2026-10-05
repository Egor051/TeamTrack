import type { TaskItem } from '@/lib/supabase/client';
import { supabase } from '@/lib/supabase/client';
import { ResourceAccessDeniedError } from '@/lib/errors/domain-errors';
import { activeCacheUserId, getCached, isExplicitAccessError, putCached } from './cache';
import { cacheAccessDecision, cacheAccessEpoch, confirmCacheAccess, deniedSince, denyCacheAccess } from './access-state';
import { localCacheDriver } from './driver';
import { applyPendingOperations, listPendingOperations } from './outbox';
import { announceSyncChange, subscribeSyncChanges } from './sync';
import { getSyncState, subscribeSyncState } from './status';
import { performSupportedEdit } from './edit';
import { usesLocalReads } from '@/lib/connectivity/state';
import { ConnectivityUnavailableError } from '@/lib/connectivity/errors';
import { uiRead } from '@/lib/supabase/ui-read';

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
    const revoked = await getCached<boolean>(userId, `blocked-task:${taskId}`)
      || (task && await getCached<boolean>(userId, `blocked:${task.project_id}`));
    await ensureUser(userId);
    if (revoked || cacheAccessDecision(userId, `blocked-task:${taskId}`)
      || (task && cacheAccessDecision(userId, `blocked:${task.project_id}`))) throw new ResourceAccessDeniedError('Нет доступа к этапу.');
    return applyPendingOperations(confirmed, pending, userId, taskId);
  },
  refreshTaskItems(userId: string, taskId: string, mode: ChecklistMode): Promise<TaskItem[]> {
    const identity = `${userId}:${taskId}:${mode}`;
    const existing = refreshes.get(identity);
    if (existing) return existing;
    const task = (async () => {
      await ensureUser(userId);
      if (usesLocalReads()) {
        const local = await ChecklistLocalRepository.getEffectiveTaskItems(userId, taskId, mode);
        if (!local) throw new ConnectivityUnavailableError();
        return local;
      }
      // The baseline belongs to the request, not to the moment it finishes.
      // Pull/reconciliation may change list membership while HTTP is in flight.
      const old = await localCacheDriver.get(userId, key(taskId, mode));
      const accessBaseline = cacheAccessEpoch();
      const accessKey = `blocked-task:${taskId}`;
      const access = await uiRead(supabase.from('tasks').select('id').eq('id', taskId).maybeSingle());
      if (access.error) {
        if (isExplicitAccessError(access.error)) await putCached(userId, accessKey, true);
        throw access.error;
      }
      if (!access.data) {
        denyCacheAccess(userId, accessKey); await putCached(userId, accessKey, true);
        throw new ResourceAccessDeniedError('Нет доступа к этапу.');
      }
      const rows: TaskItem[] = [];
      for (let from = 0; ; from += 500) {
        let query = supabase.from('task_items').select('*').eq('task_id', taskId).order('position').order('id').range(from, from + 499);
        if (mode !== 'all') query = query.eq('is_archived', mode === 'archived');
        const { data, error } = await uiRead(query);
        if (error) { if (isExplicitAccessError(error)) await putCached(userId, accessKey, true); throw error; }
        rows.push(...(data ?? []));
        if (!data || data.length < 500) break;
      }
      await ensureUser(userId);
      if (deniedSince(userId, accessKey, accessBaseline)) throw new ResourceAccessDeniedError('Доступ был отозван во время загрузки.');
      const serialized = JSON.stringify(rows);
      await localCacheDriver.putIfUnchanged({ user_id: userId, key: key(taskId, mode), data: serialized,
        last_synced_at: new Date().toISOString(), schema_version: 1 }, old?.data ?? null);
      if (!confirmCacheAccess(userId, accessKey, accessBaseline)) throw new ResourceAccessDeniedError('Доступ был отозван во время загрузки.');
      await localCacheDriver.remove(userId, accessKey);
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
