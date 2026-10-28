import { OperationError } from '@/lib/errors/operation-error';
import type { CacheEntry } from './types';
import { validSyncVersion } from './pull-cache';

/** Only confirmed cache data may become the base of a new durable operation. */
export function confirmedItem(entry: CacheEntry | null | undefined, itemId: string): { id: string; sync_version: number } | null {
  if (!entry) return null;
  try {
    const rows: unknown = JSON.parse(entry.data);
    if (!Array.isArray(rows) || entry.schema_version !== 1) throw new Error('Invalid confirmed snapshot');
    const item = rows.find((row) => row && typeof row === 'object' && row.id === itemId);
    if (!item) return null;
    if (!validSyncVersion(item.sync_version)) return null;
    return { id: item.id, sync_version: item.sync_version };
  } catch (cause) {
    throw new OperationError('local_data', 'TT_LOCAL_SNAPSHOT_INVALID', 'enqueue', { cause });
  }
}
