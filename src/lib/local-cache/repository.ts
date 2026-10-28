import type { TaskItem } from '@/lib/supabase/client';
import { supabase } from '@/lib/supabase/client';
import { ResourceAccessDeniedError } from '@/lib/errors/domain-errors';
import { activeCacheUserId, getCached, readCachedModel, inheritCachedResult, SupersededReadError, isTaskProjectBlocked } from './cache';
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
import { readSnapshotPages } from './snapshot-pages';
import { OperationError } from '@/lib/errors/operation-error';
import { confirmedItem } from './confirmed-item';

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
    if (task && await isTaskProjectBlocked(userId, taskId, task.project_id)) throw new ResourceAccessDeniedError('Нет доступа к проекту.');
    const confirmed = await getCached<TaskItem[]>(userId, key(taskId, mode));
    if (!confirmed) return null;
    const pending = await listPendingOperations(userId, taskId);
    const revoked = await getCached<boolean>(userId, `blocked-task:${taskId}`)
      || (task && await isTaskProjectBlocked(userId, taskId, task.project_id));
    await ensureUser(userId);
    const access = await durableReadInvalidation(userId, key(taskId, mode));
    if (readAccountEpoch() !== accountBaseline || access.kind === 'access' || readInvalidation(userId, key(taskId, mode)).kind === 'access')
      throw new SupersededReadError('Сеанс или доступ изменился во время загрузки.');
    if (revoked || cacheAccessDecision(userId, `blocked-task:${taskId}`)
      || (task && await isTaskProjectBlocked(userId, taskId, task.project_id))) throw new ResourceAccessDeniedError('Нет доступа к этапу.');
    return applyPendingOperations(confirmed, pending, userId, taskId);
  },
  async refreshTaskItems(userId: string, taskId: string, mode: ChecklistMode, forceRefresh = true, requireDurable = false): Promise<TaskItem[]> {
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
      const rows = await readSnapshotPages<TaskItem>((offset, revision) => uiRead(supabase.rpc('get_task_item_snapshot_page', {
        p_task_id: taskId, p_mode: mode, p_offset: offset, p_limit: 500, p_revision: revision ?? undefined,
      })));
      await ensureUser(userId);
      return rows;
    }, { taskId, clearTaskBlockOnSuccess: true, forceRefresh, requireDurable,
      onServerCommit: async (rows) => { if (old?.data !== JSON.stringify(rows)) announceSyncChange(userId); } });
    await ensureUser(userId);
    const pending = await listPendingOperations(userId, taskId);
    if (readAccountEpoch() !== accountBaseline || readInvalidation(userId, key(taskId, mode)).kind === 'access'
      || (await durableReadInvalidation(userId, key(taskId, mode))).kind === 'access') throw new SupersededReadError('Сеанс или доступ изменился во время загрузки.');
    if (await getCached<boolean>(userId, `blocked-task:${taskId}`)
      || (parent && await isTaskProjectBlocked(userId, taskId, parent.project_id))) throw new ResourceAccessDeniedError('Нет доступа к этапу.');
    return inheritCachedResult(confirmed, applyPendingOperations(confirmed, pending, userId, taskId));
  },
  async recoverItemSnapshot(userId: string, taskId: string, itemId: string, displayedVersion: number): Promise<void> {
    if (usesLocalReads()) throw new OperationError('local_data', 'TT_LOCAL_SNAPSHOT_MISSING', 'snapshot_recovery');
    await this.refreshTaskItems(userId, taskId, 'active', true, true);
    await ensureUser(userId);
    const item = confirmedItem(await localCacheDriver.get(userId, key(taskId, 'active')), itemId);
    if (!item) throw new OperationError('local_data', 'TT_LOCAL_SNAPSHOT_MISSING', 'snapshot_recovery');
    if (item.sync_version !== displayedVersion) throw new OperationError('conflict', 'PT409', 'snapshot_recovery');
  },
  subscribe: subscribeSyncChanges,
  subscribeSyncState,
  getSyncState,
  mutate: performSupportedEdit,
};
