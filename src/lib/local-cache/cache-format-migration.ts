import { localCacheDriver } from './driver';
import { cacheEntry } from './bootstrap-models';
import { BOOTSTRAP_KEY, requiredDatasets, type BootstrapMetadata } from './bootstrap-types';
import { BOOTSTRAP_PAGE_SIZE, checksum, contentPageEntry, retainedBootstrapPages, storedPage } from './bootstrap-pages';
import { freshnessKey, GLOBAL_ACL_KEY, readInvalidation, storedReadInvalidation } from './read-freshness';
import type { CacheEntry } from './types';
import type { TaskItem } from '@/lib/supabase/client';

function coveredProjection(all: CacheEntry, stored: Map<string, CacheEntry>): boolean {
  const prefix = all.key.slice(0, -3);
  try {
    const rows = JSON.parse(all.data) as TaskItem[];
    if (!Array.isArray(rows)) return false;
    const canonical = new Map<string, TaskItem>();
    for (const mode of ['active', 'archived']) {
      const entry = stored.get(`${prefix}${mode}`);
      if (!entry || entry.schema_version !== 1 || !Number.isFinite(Date.parse(entry.last_synced_at))) return false;
      if (readInvalidation(all.user_id, entry.key).kind === 'access' || storedReadInvalidation(stored, entry.key).kind === 'access') return false;
      const items = JSON.parse(entry.data) as TaskItem[];
      if (!Array.isArray(items)) return false;
      for (const item of items) {
        if (!item?.id || item.task_id !== prefix.slice(6, -1) || item.is_archived !== (mode === 'archived') || canonical.has(item.id)) return false;
        canonical.set(item.id, item);
      }
    }
    return rows.every((row) => {
      const item = canonical.get(row.id);
      return !!item && ((item.sync_version ?? 0) > (row.sync_version ?? 0)
        || ((item.sync_version ?? 0) === (row.sync_version ?? 0)
          && Object.keys(row).every((key) => JSON.stringify(item[key as keyof TaskItem]) === JSON.stringify(row[key as keyof TaskItem]))));
    });
  } catch { return false; }
}

// Called only after local readiness verification. No HTTP, version bump, or
// staging state: pages, certificates and deletions switch in one transaction.
export async function migrateVerifiedCache(userId: string, signal?: AbortSignal): Promise<'unchanged' | 'committed' | 'superseded'> {
  const driver = signal && localCacheDriver.withOperation ? localCacheDriver.withOperation(signal) : localCacheDriver;
  const entries = await driver.listEntries(userId);
  const stored = new Map(entries.filter((e) => e.user_id === userId && e.schema_version === 1).map((e) => [e.key, e]));
  const metadata = stored.get(BOOTSTRAP_KEY);
  if (!metadata) return 'unchanged';
  const meta = JSON.parse(metadata.data) as BootstrapMetadata;
  if (meta.user_id !== userId || !meta.verified?.basic || !meta.basic_ready || (meta.lease && meta.lease.expires_at > Date.now())) return 'unchanged';
  const additions = new Map<string, CacheEntry>();
  const converted = new Set<string>();
  let changed = false;
  for (const scheme of ['basic', 'extended'] as const) {
    const certificate = meta.verified[scheme];
    if (!certificate?.batches) continue; // Uncertified legacy hashes remain usable in their original format.
    const batches = { ...certificate.batches };
    for (const name of requiredDatasets(scheme)) {
      const version = certificate.manifest.datasets[name];
      if (!version) continue;
      for (let offset = 0; offset < version.count; offset += BOOTSTRAP_PAGE_SIZE) {
        const source = storedPage(stored, name, version, offset, certificate);
        if (!source || !source.entry.key.startsWith('bootstrap:batch:') || batches[source.entry.key] !== checksum(source.entry.data)) continue;
        const page = contentPageEntry(userId, name, version.pages[offset / BOOTSTRAP_PAGE_SIZE], source.rows);
        // Reuse a valid existing immutable page, never silently replace one
        // referenced by another certificate with different certified content.
        const existing = stored.get(page.key);
        if (existing && existing.data !== page.data) continue;
        if (!existing) additions.set(page.key, page);
        delete batches[source.entry.key]; batches[page.key] = checksum(page.data);
        converted.add(source.entry.key); changed = true;
      }
    }
    certificate.batches = batches;
  }
  const removed = entries.filter((e) => e.user_id === userId && e.schema_version === 1
    && /^items:.*:all$/.test(e.key) && coveredProjection(e, stored)).map((e) => e.key);
  if (removed.length) {
    for (const certificate of Object.values(meta.verified)) if (certificate) certificate.models = certificate.models.filter((key) => !removed.includes(key));
    changed = true;
  }
  const retained = retainedBootstrapPages(meta);
  removed.push(...[...converted].filter((key) => !retained.has(key)));
  if (!changed) return 'unchanged';
  // Guard all certificate inputs/models plus absence of new destinations.
  // A concurrent pull, preparation, scheme switch or ACL event aborts cleanup.
  const guards: { key: string; data: string | null }[] = entries.filter((e) => e.user_id === userId).map((e) => ({ key: e.key, data: e.data }));
  const guarded = new Set(guards.map((g) => g.key));
  for (const key of [GLOBAL_ACL_KEY, ...Object.values(meta.verified).flatMap((c) => c?.models.map(freshnessKey) ?? [])])
    if (!guarded.has(key)) { guards.push({ key, data: null }); guarded.add(key); }
  for (const key of additions.keys()) guards.push({ key, data: null });
  return await driver.commitCacheBatch(userId, [...additions.values(), cacheEntry(userId, BOOTSTRAP_KEY, meta)], removed, guards, signal) ? 'committed' : 'superseded';
}
