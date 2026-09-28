export const LOCAL_CACHE_SCHEMA_VERSION = 1;

export type CacheEntry = {
  user_id: string;
  key: string;
  data: string;
  last_synced_at: string;
  schema_version: number;
};

export interface LocalCacheDriver {
  get(userId: string, key: string): Promise<CacheEntry | null>;
  put(entry: CacheEntry): Promise<void>;
  remove(userId: string, key: string): Promise<void>;
}
