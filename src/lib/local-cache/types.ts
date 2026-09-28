export const LOCAL_CACHE_SCHEMA_VERSION = 1;

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
};

export type OfflineOperation = OfflineOperationInput & { sequence: number };

export interface LocalCacheDriver {
  get(userId: string, key: string): Promise<CacheEntry | null>;
  put(entry: CacheEntry): Promise<void>;
  remove(userId: string, key: string): Promise<void>;
  enqueue(operation: OfflineOperationInput): Promise<OfflineOperation>;
  listPending(userId: string, taskId?: string): Promise<OfflineOperation[]>;
}
