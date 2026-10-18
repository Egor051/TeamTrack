export const LOCAL_CACHE_SCHEMA_VERSION = 1;

// Version 1 template lists may have been silently capped by the old table RPC.
// Both paged UI reads and the verified account bootstrap produce version 2.
// Keep the same keys, transactions and ACL fences; unrelated offline data stays usable.
export function cacheSchemaVersion(key: string): number {
  return key === 'templates' || key.startsWith('template-items:') ? 2 : LOCAL_CACHE_SCHEMA_VERSION;
}

export type CacheEntry = {
  user_id: string;
  key: string;
  data: string;
  last_synced_at: string;
  schema_version: number;
};

export type OfflineOperationInput = {
  operation_id: string;
  user_id: string;
  project_id: string;
  task_id: string;
  task_item_id: string;
  type: 'set_task_item_state' | 'set_task_item_percentage' | 'set_task_item_comment';
  payload: { completed: boolean } | { percentage: number } | { comment: string | null };
  created_at: string;
  status: 'pending';
  // The first edit captures a confirmed server version. Following edits wait
  // for their predecessor's acknowledged version instead of guessing one.
  expected_version?: number | null;
  depends_on_operation_id?: string | null;
  protocol_version?: number;
};

export type OperationStatus = 'pending' | 'synced_unreconciled' | 'failed' | 'conflict';
export type OfflineOperation = Omit<OfflineOperationInput, 'status'> & {
  sequence: number;
  status: OperationStatus;
  server_result?: boolean | number | string | null;
  last_error?: string | null;
  server_version?: number | null;
};

export type ReconciledItem = {
  id: string;
  percentage: number;
  is_completed: boolean;
  comment: string | null;
  deadline_at?: string | null;
  sync_version?: number;
  is_archived?: boolean;
  title?: string;
  task_id?: string;
};

export type SyncConflict = {
  conflict_id: string;
  user_id: string;
  project_id: string;
  task_id: string;
  task_item_id: string;
  operation_ids: string[];
  local_effective_state: ReconciledItem;
  server_state: ReconciledItem | null;
  server_version: number | null;
  conflicting_fields: ('progress' | 'comment')[];
  project_name: string;
  task_name: string;
  item_name: string;
  created_at: string;
  updated_at: string;
  status: 'unresolved';
};

export type PullChange = {
  cursor: number;
  task_id: string;
  task_item_id: string;
  change_type: 'upsert' | 'delete';
  item: ReconciledItem | null;
};

export interface LocalCacheDriver {
  // Operation-scoped transactions abort/roll back if their worker is superseded.
  withOperation?(signal: AbortSignal): LocalCacheDriver;
  // Confirmed cache/metadata only. Never touches pending operations/conflicts.
  commitCacheBatch(userId: string, entries: CacheEntry[], removeKeys?: string[], guards?: { key: string; data: string | null }[], signal?: AbortSignal): Promise<boolean>;
  get(userId: string, key: string): Promise<CacheEntry | null>;
  put(entry: CacheEntry): Promise<void>;
  putIfUnchanged(entry: CacheEntry, expectedData: string | null): Promise<boolean | void>;
  remove(userId: string, key: string): Promise<void>;
  listEntries(userId: string, prefix?: string): Promise<CacheEntry[]>;
  enqueue(operation: OfflineOperationInput): Promise<OfflineOperation>;
  listPending(userId: string, taskId?: string): Promise<OfflineOperation[]>;
  markOperation(userId: string, operationId: string, status: OperationStatus, result?: OfflineOperation['server_result'], error?: string): Promise<void>;
  acknowledgeOperation(userId: string, operationId: string, version: number, conflictId?: string, item?: ReconciledItem): Promise<void>;
  listConflicts(userId: string): Promise<SyncConflict[]>;
  createConflict(conflict: SyncConflict): Promise<void>;
  rebaseConflict(userId: string, conflictId: string, version: number): Promise<void>;
  resolveServerConflict(userId: string, conflictId: string): Promise<void>;
  finishMineConflict(userId: string, conflictId: string): Promise<void>;
  discardFailedChain(userId: string, taskId: string, itemId: string, projectId: string, serverState: ReconciledItem | null,
    expected?: Pick<OfflineOperation, 'operation_id' | 'status'>[]): Promise<void>;
  initializePullCursor(userId: string, cursor: number): Promise<boolean>;
  applyPullPage(userId: string, afterCursor: number, nextCursor: number, changes: PullChange[]): Promise<boolean>;
  reconcileOperation(userId: string, operationId: string, item: ReconciledItem | null, snapshot: ReconciledItem[] | null,
    guards?: { key: string; data: string | null }[]): Promise<void>;
}
