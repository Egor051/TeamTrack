import { activeCacheUserId } from './cache';
import { enqueueOperation, hasPendingOperations, type SupportedEdit } from './outbox';
import type { OfflineOperation } from './types';
import { runtimeCapabilities, localWriteDenial } from './runtime-config';
import { syncPendingOperations, announceSyncChange } from './sync';
import { requestOfflineWork } from './work-requests';
import { annotateError, OperationError, type OperationStage } from '@/lib/errors/operation-error';
import { usesLocalReads } from '@/lib/connectivity/state';
import { reportClientError } from '@/lib/errors/error-events';

export async function performSupportedEdit(input: {
  userId: string;
  projectId: string;
  taskId: string;
  itemId: string;
  itemVersion: number;
  offline: boolean;
  edit: SupportedEdit;
  onlineAction: () => Promise<unknown>;
  recoverLocalSnapshot?: () => Promise<void>;
}): Promise<{ kind: 'server' } | { kind: 'local'; operation: OfflineOperation }> {
  let stage: OperationStage = 'identity';
  let capabilities: Awaited<ReturnType<typeof runtimeCapabilities>> | undefined;
  try {
    if (await activeCacheUserId() !== input.userId) throw new OperationError('session', 'TT_SESSION', stage);
    stage = 'version';
    if (!Number.isSafeInteger(input.itemVersion) || input.itemVersion < 1) throw new OperationError('local_data', 'TT_LOCAL_VERSION', stage);
    stage = 'capabilities';
    capabilities = await runtimeCapabilities(input.userId);
    const enabled = capabilities.write;
    stage = 'outbox';
    const dirty = await hasPendingOperations(input.userId, input.taskId, input.itemId);
    if (dirty && !enabled) throw capabilities.available ? new OperationError('write_disabled', 'TT_WRITE_DISABLED', 'capabilities') : await localWriteDenial(capabilities);
    if (!enabled) {
      if (input.offline) throw capabilities.available ? new OperationError('write_disabled', 'TT_WRITE_DISABLED', 'capabilities') : await localWriteDenial(capabilities);
      stage = 'mutation';
      await input.onlineAction();
      return { kind: 'server' };
    }
    stage = 'enqueue';
    let operation: OfflineOperation;
    try {
      operation = await enqueueOperation(input.userId, input.projectId, input.taskId, input.itemId, input.edit, input.itemVersion);
    } catch (error) {
      // These guards abort BEFORE adding anything to the outbox. A single server
      // refresh may repair the base, but never retries an ambiguous storage write.
      if (!(error instanceof OperationError) || !['TT_LOCAL_SNAPSHOT_MISSING', 'TT_LOCAL_SNAPSHOT_INVALID'].includes(error.code)
        || !input.recoverLocalSnapshot || usesLocalReads()) throw error;
      stage = 'snapshot_recovery';
      reportClientError(error, { stage, operation: input.edit.type, userId: input.userId,
        taskId: input.taskId, itemId: input.itemId, displayedVersion: input.itemVersion, capabilities });
      await input.recoverLocalSnapshot();
      if (await activeCacheUserId() !== input.userId) throw new OperationError('session', 'TT_SESSION', 'identity');
      stage = 'enqueue';
      operation = await enqueueOperation(input.userId, input.projectId, input.taskId, input.itemId, input.edit, input.itemVersion);
    }
    announceSyncChange(input.userId);
    void (requestOfflineWork(input.userId, 'mutations') ?? syncPendingOperations(input.userId)).catch(() => undefined);
    return { kind: 'local', operation };
  } catch (error) {
    annotateError(error, { stage, operation: input.edit.type, userId: input.userId, taskId: input.taskId,
      itemId: input.itemId, displayedVersion: input.itemVersion, capabilities });
    throw error;
  }
}
