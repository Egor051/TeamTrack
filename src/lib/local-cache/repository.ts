import type { TaskItem } from '@/lib/supabase/client';
import { supabase } from '@/lib/supabase/client';
import { ResourceAccessDeniedError } from '@/lib/errors/domain-errors';
import { activeCacheUserId, getCached, readCachedModel, inheritCachedResult } from './cache';
import { cacheAccessDecision } from './access-state';
import { localCacheDriver } from './driver';
import { applyPendingOperations, listPendingOperations } from './outbox';
import { announceSyncChange, subscribeSyncChanges } from './sync';
import { getSyncState, subscribeSyncState } from './status';
import { performSupportedEdit } from './edit';
import { usesLocalReads } from '@/lib/connectivity/state';
import { ConnectivityUnavailableError } from '@/lib/connectivity/errors';
import { uiRead } from '@/lib/supabase/ui-read';
import { durableReadInvalidation, readAccountEpoch, readInvalidation } from './read-freshness';

export type ChecklistMode = 'active' | 'archived' | 'all';
const key = (taskId: string, mode: ChecklistMode) => `items:${taskId}:${mode}`;

async function ensureUser(userId: string): Promise<void> {
  if (!userId || await activeCacheUserId() !== userId) throw new Error('Сеанс изменился.');
}

export const ChecklistLocalRepository = {
  async getEffectiveTaskItems(userId: string, taskId: string, mode: ChecklistMode): Promise<TaskItem[] | null> {
    const accountBaseline = readAccountEpoch();
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
    const access = await durableReadInvalidation(userId, key(taskId, mode));
    if (readAccountEpoch() !== accountBaseline || access.kind === 'access' || readInvalidation(userId, key(taskId, mode)).kind === 'access'
      || revoked || cacheAccessDecision(userId, `blocked-task:${taskId}`)
      || (task && cacheAccessDecision(userId, `blocked:${task.project_id}`))) throw new ResourceAccessDeniedError('Нет доступа к этапу.');
    return applyPendingOperations(confirmed, pending, userId, taskId);
  },
  async refreshTaskItems(userId: string, taskId: string, mode: ChecklistMode, forceRefresh = true): Promise<TaskItem[]> {
    const accountBaseline = readAccountEpoch();
    await ensureUser(userId);
    if (usesLocalReads()) {
      const local = await ChecklistLocalRepository.getEffectiveTaskItems(userId, taskId, mode);
      if (!local) throw new ConnectivityUnavailableError();
      return local;
    }
    // The baseline belongs to the request, not to the moment it finishes.
    // Pull/reconciliation may change list membership while HTTP is in flight.
    const old = await localCacheDriver.get(userId, key(taskId, mode));
    const parent = await getCached<{ project_id: string }>(userId, `task:${taskId}`);
    const confirmed = await readCachedModel(key(taskId, mode), async () => {
      const access = await uiRead(supabase.from('tasks').select('id').eq('id', taskId).maybeSingle());
      if (access.error) throw access.error;
      if (!access.data) throw new ResourceAccessDeniedError('Нет доступа к этапу.');
      const rows: TaskItem[] = [];
      for (let from = 0; ; from += 500) {
        let query = supabase.from('task_items').select('*').eq('task_id', taskId).order('position').order('id').range(from, from + 499);
        if (mode !== 'all') query = query.eq('is_archived', mode === 'archived');
        const { data, error } = await uiRead(query);
        if (error) throw error;
        rows.push(...(data ?? []));
        if (!data || data.length < 500) break;
      }
      await ensureUser(userId);
      return rows;
    }, { taskId, projectId: parent?.project_id, clearTaskBlockOnSuccess: true, forceRefresh,
      onServerCommit: async (rows) => { if (old?.data !== JSON.stringify(rows)) announceSyncChange(userId); } });
    await ensureUser(userId);
    const pending = await listPendingOperations(userId, taskId);
    if (readAccountEpoch() !== accountBaseline || readInvalidation(userId, key(taskId, mode)).kind === 'access'
      || (await durableReadInvalidation(userId, key(taskId, mode))).kind === 'access') throw new ResourceAccessDeniedError('Сеанс или доступ изменился во время загрузки.');
    if (await getCached<boolean>(userId, `blocked-task:${taskId}`)
      || (parent && await getCached<boolean>(userId, `blocked:${parent.project_id}`))) throw new ResourceAccessDeniedError('Нет доступа к этапу.');
    return inheritCachedResult(confirmed, applyPendingOperations(confirmed, pending, userId, taskId));
  },
  subscribe: subscribeSyncChanges,
  subscribeSyncState,
  getSyncState,
  mutate: performSupportedEdit,
};
