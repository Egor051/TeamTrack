import { BASIC_DATASETS, batchKey, pageKey, type Dataset, type DatasetVersion, type SnapshotEvidence } from './bootstrap-types';
import { cacheEntry } from './bootstrap-models';
import type { CacheEntry } from './types';

export const BOOTSTRAP_PAGE_SIZE = 500;
// Detect accidental storage damage; server manifest hashes identify content.
// Neither this checksum nor a manifest is a client-side authorization grant.
export function checksum(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16);
}
export function contentPageEntry(userId: string, name: Dataset, hash: string, rows: unknown[]): CacheEntry {
  return cacheEntry(userId, pageKey(name, hash), { hash, rows, checksum: checksum(JSON.stringify(rows)) });
}
export function storedPage(stored: Map<string, CacheEntry>, name: Dataset, version: DatasetVersion, offset: number,
  evidence?: SnapshotEvidence | null): { entry: CacheEntry; rows: unknown[] } | null {
  const hash = version.pages[offset / BOOTSTRAP_PAGE_SIZE];
  const contentKey = pageKey(name, hash);
  const legacyKey = batchKey(name, version.revision, offset);
  // Old certificates continue to use their original physical page until an
  // atomic commit publishes the new certificate. No database upgrade needed.
  const keys = evidence?.batches?.[legacyKey] !== undefined ? [legacyKey, contentKey] : [contentKey, legacyKey];
  for (const key of keys) {
    const entry = stored.get(key);
    if (!entry) continue;
    try {
      const value = JSON.parse(entry.data);
      const rows = key === contentKey ? value.rows : value;
      if (key === contentKey && (value.hash !== hash || !Array.isArray(rows) || value.checksum !== checksum(JSON.stringify(rows)))) continue;
      if (evidence?.batches && evidence.batches[key] !== checksum(entry.data)) continue;
      if (Array.isArray(rows) && rows.length === Math.min(BOOTSTRAP_PAGE_SIZE, version.count - offset)) return { entry, rows };
    } catch { /* A damaged page must be downloaded again. */ }
  }
  return null;
}

// This mark set contains only bootstrap page keys. Call sweep while holding
// the existing account lease, and commit deletions with the metadata CAS.
export function retainedBootstrapPages(meta: import('./bootstrap-types').BootstrapMetadata): Set<string> {
  const retained = new Set<string>();
  for (const evidence of Object.values(meta.verified ?? {})) if (evidence) {
    if (evidence.batches) Object.keys(evidence.batches).forEach((key) => retained.add(key));
    else for (const [name, version] of Object.entries(evidence.manifest.datasets)) {
      for (let offset = 0; offset < version.count; offset += BOOTSTRAP_PAGE_SIZE) retained.add(batchKey(name as Dataset, version.revision, offset));
    }
  }
  for (const [name, state] of Object.entries(meta.datasets)) {
    if (meta.scheme === 'basic' && !(BASIC_DATASETS as readonly string[]).includes(name)) continue;
    state.pages.forEach((hash) => retained.add(pageKey(name as Dataset, hash)));
  }
  return retained;
}
