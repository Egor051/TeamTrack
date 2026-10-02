import { supabase } from '@/lib/supabase/client';
import { activeCacheUserId, isExplicitAccessError, isTransportFailure } from './cache';
import { localCacheDriver } from './driver';
import { newOperationId } from './uuid';
import { accountReadModels, cacheEntry, type AccountRows } from './bootstrap-models';
import { BASIC_DATASETS, BOOTSTRAP_KEY, OFFLINE_BOOTSTRAP_VERSION, batchKey, bootstrapProgress,
  initialBootstrap, requiredDatasets, type AccountManifest, type BootstrapMetadata, type Dataset, type OfflineScheme } from './bootstrap-types';
import type { CacheEntry } from './types';
import { getUtcPlus3DayStart } from './day';

const PAGE_SIZE = 500;
const LEASE_MS = 45_000;
export const BOOTSTRAP_REFRESH_MS = 5 * 60_000;
export const BOOTSTRAP_COALESCE_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
type RunResult = 'settled' | 'busy';
const inFlight = new Map<string, Promise<RunResult>>();
const cancellations = new Map<string, number>();
// If storage accepts reads but rejects the first write (for example quota),
// keep a user-scoped UI error until retry. Never use this as a data snapshot.
const storageFailures = new Map<string, BootstrapMetadata>();
const listeners = new Set<(userId: string) => void>();
let channel: BroadcastChannel | null = null;
function broadcast(): BroadcastChannel | null {
  if (!channel && typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('tasktrace-offline-bootstrap');
    channel.onmessage = (event) => {
      if (typeof event.data?.user_id === 'string') listeners.forEach((fn) => fn(event.data.user_id));
    };
  }
  return channel;
}
function announce(userId: string): void {
  listeners.forEach((fn) => fn(userId));
  broadcast()?.postMessage({ user_id: userId });
}
export function subscribeBootstrap(listener: (userId: string) => void): () => void {
  broadcast(); listeners.add(listener); return () => { listeners.delete(listener); };
}
export function cancelAccountBootstrap(userId: string): void {
  cancellations.set(userId, (cancellations.get(userId) ?? 0) + 1);
}
export function bootstrapDelay(meta: BootstrapMetadata, now = Date.now()): number {
  return Math.max(0, (meta.retry?.next_retry_at ?? 0) - now,
    (meta.lease?.expires_at ?? 0) - now,
    meta.last_attempt_at === undefined ? 0 : meta.last_attempt_at + BOOTSTRAP_COALESCE_MS - now);
}
function snapshotConflict(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === '40001' || (value?.code === 'PT409' && /^offline snapshot (changed|expired)/.test(value.message ?? ''));
}
export async function getBootstrapMetadata(userId: string): Promise<BootstrapMetadata> {
  if (storageFailures.has(userId)) return storageFailures.get(userId)!;
  const entry = await localCacheDriver.get(userId, BOOTSTRAP_KEY);
  if (!entry) return initialBootstrap(userId);
  const value = JSON.parse(entry.data) as BootstrapMetadata;
  if (value.user_id !== userId || value.schema_version !== OFFLINE_BOOTSTRAP_VERSION) return initialBootstrap(userId);
  if (value.manifest && new Date(value.manifest.day_start).toISOString() !== getUtcPlus3DayStart()) {
    const loading = value.status === 'running' || value.status === 'updating';
    const stale: BootstrapMetadata = { ...value, status: loading ? value.status : 'partial',
      offline_ready: false, basic_ready: false, extended_ready: false,
      datasets: { ...value.datasets, ...(value.datasets.daily_audit ? { daily_audit: { ...value.datasets.daily_audit, status: 'pending' as const, offset: 0 } } : {}) },
      error: loading ? value.error : 'Наступил новый день. Подключитесь к сети, чтобы обновить дневной прогресс.' };
    stale.progress = bootstrapProgress(stale);
    return stale;
  }
  return value;
}
async function writeMeta(meta: BootstrapMetadata, baseline: string | null, entries: CacheEntry[] = [], remove: string[] = [], guards: { key: string; data: string | null }[] = []): Promise<void> {
  meta.progress = bootstrapProgress(meta);
  if (!await localCacheDriver.commitCacheBatch(meta.user_id, [...entries, cacheEntry(meta.user_id, BOOTSTRAP_KEY, meta)], remove,
    [{ key: BOOTSTRAP_KEY, data: baseline }, ...guards])) throw new Error('Bootstrap lease changed');
  announce(meta.user_id);
}
export async function selectOfflineScheme(userId: string, scheme: OfflineScheme): Promise<void> {
  if (await activeCacheUserId() !== userId) throw new Error('Сеанс изменился.');
  if (scheme !== 'basic' && scheme !== 'extended') throw new Error('Некорректная схема офлайн-режима.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const entry = await localCacheDriver.get(userId, BOOTSTRAP_KEY);
    const meta = await getBootstrapMetadata(userId);
    if (meta.scheme === scheme && entry) return;
    meta.scheme = scheme; meta.lease = null; meta.error = null;
    meta.offline_ready = scheme === 'basic' ? meta.basic_ready : meta.extended_ready;
    meta.status = meta.offline_ready ? 'ready' : 'partial';
    meta.progress = bootstrapProgress(meta);
    if (await localCacheDriver.commitCacheBatch(userId, [cacheEntry(userId, BOOTSTRAP_KEY, meta)], [], [{ key: BOOTSTRAP_KEY, data: entry?.data ?? null }])) {
      cancelAccountBootstrap(userId); announce(userId);
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      // Wait for the superseded runner to release its lock before starting.
      void (inFlight.get(userId) ?? Promise.resolve()).finally(() => runAccountBootstrap(userId, true)).catch(() => undefined);
      return;
    }
  }
  throw new Error('Не удалось сохранить настройку. Повторите выбор.');
}

function validateManifest(value: unknown, userId: string, scheme: OfflineScheme): AccountManifest {
  const manifest = value as AccountManifest | null;
  if (!manifest || manifest.user_id !== userId || manifest.schema_version !== OFFLINE_BOOTSTRAP_VERSION
    || !Number.isFinite(Date.parse(manifest.day_start)) || !Number.isFinite(Date.parse(manifest.generated_at))
    || !Number.isFinite(Date.parse(manifest.history_start))) throw new Error('Некорректный snapshot аккаунта.');
  if (manifest.snapshot_at !== undefined && (typeof manifest.snapshot_at !== 'string' || !Number.isFinite(Date.parse(manifest.snapshot_at))))
    throw new Error('Некорректная граница snapshot.');
  for (const name of requiredDatasets(scheme)) {
    const dataset = manifest.datasets?.[name];
    if (!dataset || !Number.isSafeInteger(dataset.count) || dataset.count < 0 || !/^[a-f0-9]{32}$/.test(dataset.revision))
      throw new Error('Отсутствует обязательный набор данных.');
    if (!Array.isArray(dataset.pages) || dataset.pages.length !== Math.ceil(dataset.count / PAGE_SIZE)
      || dataset.pages.some((hash) => !/^[a-f0-9]{32}$/.test(hash))) throw new Error('Некорректные версии страниц snapshot.');
  }
  if (manifest.datasets.profile?.count !== 1) throw new Error('Не найден профиль пользователя.');
  // Preserve snapshot_at verbatim: Date/toISOString would truncate Postgres
  // microseconds and subtly change the server's membership window.
  return { ...manifest, day_start: new Date(manifest.day_start).toISOString(),
    generated_at: new Date(manifest.generated_at).toISOString(), history_start: new Date(manifest.history_start).toISOString() };
}
async function manifestFor(userId: string, scheme: OfflineScheme, snapshotAt?: string): Promise<AccountManifest> {
  const { data, error } = await supabase.rpc('get_offline_account_manifest',
    { p_scheme: scheme, ...(snapshotAt ? { p_snapshot_at: snapshotAt } : {}) }).abortSignal(AbortSignal.timeout(20_000));
  if (error) throw error;
  return validateManifest(data, userId, scheme);
}
export async function prepareOfflineAssets(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker || typeof caches === 'undefined') return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => { timeout = setTimeout(() => resolve(null), 20_000); }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!registration?.active) return false;
  const assets = ['/offline-shell.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/favicon.ico',
    ...Array.from(document.scripts).map((script) => script.src).filter((src) => src.includes('/_expo/static/'))];
  for (const asset of assets) if (!await caches.match(asset, { ignoreSearch: true })) return false;
  return true;
}

async function readDataset(userId: string, name: Dataset, meta: BootstrapMetadata): Promise<unknown[]> {
  const state = meta.datasets[name];
  if (!state || state.status !== 'complete' || state.offset !== state.count) throw new Error('Набор данных не завершён.');
  const rows: unknown[] = [];
  for (let offset = 0; offset < state.count; offset += PAGE_SIZE) {
    const entry = await localCacheDriver.get(userId, batchKey(name, state.revision, offset));
    if (!entry || entry.user_id !== userId) throw new Error('Сохранённый batch отсутствует.');
    const page: unknown = JSON.parse(entry.data);
    if (!Array.isArray(page) || page.length !== Math.min(PAGE_SIZE, state.count - offset)) throw new Error('Сохранённый batch повреждён.');
    rows.push(...page);
  }
  return rows;
}

// Revoke direct-link fallback as soon as an authoritative visible list is
// downloaded, even if a later dataset fails. A full list spans both archives.
async function visibilityEntries(userId: string, name: Dataset, rows: unknown[]): Promise<CacheEntry[]> {
  if (name === 'roles') return (rows as { task_id: string; role: string }[])
    .map((row) => cacheEntry(userId, `task-role:${row.task_id}`, row.role));
  if (name !== 'projects' && name !== 'tasks') return [];
  const prefix = name === 'projects' ? 'project:' : 'task:';
  const block = name === 'projects' ? 'blocked:' : 'blocked-task:';
  const ids = new Set((rows as { id: string }[]).map((r) => r.id));
  const old = await localCacheDriver.listEntries(userId, prefix);
  return [...old.filter((e) => !ids.has(e.key.slice(prefix.length))).map((e) => cacheEntry(userId, `${block}${e.key.slice(prefix.length)}`, true)),
    ...(rows as { id: string }[]).flatMap((row) => [cacheEntry(userId, `${block}${row.id}`, false), cacheEntry(userId, `${prefix}${row.id}`, row)])];
}

async function bootstrap(userId: string, force: boolean, assets: () => Promise<boolean>): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  if (await activeCacheUserId() !== userId) return;
  storageFailures.delete(userId);
  const entry = await localCacheDriver.get(userId, BOOTSTRAP_KEY);
  let meta = await getBootstrapMetadata(userId);
  // Shared durable gates apply to every trigger, including force/reconnect.
  // A new tab or repeated connected status cannot reset a failed run's backoff.
  if (bootstrapDelay(meta) > 0) return;
  if (!force && meta.status === 'ready' && meta.last_successful_sync_at
    && Date.now() - Date.parse(meta.last_successful_sync_at) < BOOTSTRAP_REFRESH_MS) return;
  const owner = newOperationId();
  const cancellation = cancellations.get(userId) ?? 0;
  const ensureActive = async () => {
    if (await activeCacheUserId() !== userId || (cancellations.get(userId) ?? 0) !== cancellation) throw new Error('Bootstrap cancelled');
    const current = await getBootstrapMetadata(userId);
    if (current.lease?.owner !== owner) throw new Error('Bootstrap lease changed');
  };
  let baseline = entry?.data ?? null;
  const save = async (entries: CacheEntry[] = [], remove: string[] = [], guards: { key: string; data: string | null }[] = []) => {
    await ensureActive();
    if (meta.lease) meta.lease.expires_at = Date.now() + LEASE_MS;
    await writeMeta(meta, baseline, entries, remove, guards);
    baseline = JSON.stringify(meta);
  };
  meta = { ...meta, status: meta.completed_at ? 'updating' : 'running', offline_ready: false, error: null,
    started_at: new Date().toISOString(), last_attempt_at: Date.now(), lease: { owner, expires_at: Date.now() + LEASE_MS } };
  try { await writeMeta(meta, baseline); baseline = JSON.stringify(meta); }
  catch (error) {
    if (!(error instanceof Error && error.message === 'Bootstrap lease changed')) {
      storageFailures.set(userId, { ...meta, status: 'error', lease: null, offline_ready: false,
        basic_ready: false, extended_ready: false, error: 'Не удалось записать данные в локальное хранилище.' });
      announce(userId);
    }
    return; // A competing lease or unavailable local storage.
  }
  try {
    for (let restart = 0; restart < 3; restart++) {
      try {
        const manifest = await manifestFor(userId, meta.scheme);
        await ensureActive();
        meta.manifest = manifest;
        const reusable: Partial<Record<Dataset, { revision: string; offsets: Set<number> }>> = {};
        for (const name of requiredDatasets(meta.scheme)) {
          const version = manifest.datasets[name]!;
          const old = meta.datasets[name];
          if (!old || old.revision !== version.revision || old.count !== version.count) {
            if (old?.pages) reusable[name] = { revision: old.revision, offsets: new Set(version.pages.flatMap((hash, page) =>
              hash === old.pages[page] && page * PAGE_SIZE < old.offset
                ? [page * PAGE_SIZE] : [])) };
            meta.datasets[name] = { ...version, offset: 0, status: 'pending' };
            if ((BASIC_DATASETS as readonly string[]).includes(name)) meta.basic_ready = false;
            meta.extended_ready = false;
          } else if (old.status === 'complete') {
            try { await readDataset(userId, name, meta); }
            catch {
              meta.datasets[name] = { ...version, offset: 0, status: 'pending' };
              if ((BASIC_DATASETS as readonly string[]).includes(name)) meta.basic_ready = false;
              meta.extended_ready = false;
            }
          }
        }
        await save();
        for (const name of requiredDatasets(meta.scheme)) {
          const state = meta.datasets[name]!;
          if (state.status === 'complete') continue;
          state.status = 'loading'; delete state.error;
          await save();
          while (state.offset < state.count) {
            await ensureActive();
            const offset = state.offset;
            if (reusable[name]?.offsets.has(offset)) {
              const previous = await localCacheDriver.get(userId, batchKey(name, reusable[name]!.revision, offset));
              const page = previous ? JSON.parse(previous.data) as unknown : null;
              if (Array.isArray(page) && page.length === Math.min(PAGE_SIZE, state.count - offset)) {
                state.offset += page.length;
                await save([cacheEntry(userId, batchKey(name, state.revision, offset), page)]);
                continue;
              }
            }
            const { data, error } = await supabase.rpc('get_offline_account_page', { p_dataset: name, p_revision: state.revision,
              p_offset: offset, p_limit: PAGE_SIZE, ...(manifest.snapshot_at ? { p_snapshot_at: manifest.snapshot_at } : {}) }).abortSignal(AbortSignal.timeout(20_000));
            if (error) throw error;
            const page = data as { revision: string; total: number; offset: number; rows: unknown[] } | null;
            if (!page || page.revision !== state.revision || page.total !== state.count || page.offset !== offset
              || !Array.isArray(page.rows) || page.rows.length !== Math.min(PAGE_SIZE, state.count - offset)) throw new Error('Неполная страница snapshot.');
            state.offset += page.rows.length;
            await save([cacheEntry(userId, batchKey(name, state.revision, offset), page.rows)]);
          }
          state.status = 'complete'; await save();
          const savedRows = await readDataset(userId, name, meta);
          const visible = await visibilityEntries(userId, name, savedRows);
          let revokedOverrides: string[] = [];
          if (name === 'projects') {
            const administrators = new Set((savedRows as { id: string; role: string }[])
              .filter((p) => p.role === 'owner' || p.role === 'admin').map((p) => p.id));
            revokedOverrides = (await localCacheDriver.listEntries(userId, 'task:')).flatMap((e) => {
              const task = JSON.parse(e.data) as { id: string; project_id: string };
              return administrators.has(task.project_id) ? [] : [`task-overrides:${task.id}`];
            });
          }
          if (visible.length || revokedOverrides.length) await save(visible, revokedOverrides);
        }
        meta.assets_ready = await assets();
        await save();
        if (!meta.assets_ready) {
          meta.basic_ready = false; meta.extended_ready = false;
          throw new Error('Файлы приложения ещё не сохранены для офлайн-режима.');
        }
        const verified = await manifestFor(userId, meta.scheme, manifest.snapshot_at);
        if (requiredDatasets(meta.scheme).some((name) => verified.datasets[name]!.revision !== meta.datasets[name]!.revision)) {
          throw { code: '40001', message: 'Snapshot changed during verification' };
        }
        meta.manifest = verified;
        const rows: AccountRows = {};
        for (const name of requiredDatasets(meta.scheme)) rows[name] = await readDataset(userId, name, meta);
        let committed: CacheEntry[] = [];
        let removed: string[] = [];
        // Cache CAS also protects against a sync pull/ordinary online read in
        // browsers without Web Locks. Rebuild from its newly confirmed values.
        for (let attempt = 0; attempt < 3; attempt++) {
          const before = await localCacheDriver.listEntries(userId);
          committed = accountReadModels(userId, rows, verified, before);
          const keys = new Set(committed.map((e) => e.key));
          removed = before.filter((e) => /^(task-overrides:|template:|template-items:|daily-audit:)/.test(e.key) && !keys.has(e.key)).map((e) => e.key);
          const guards: { key: string; data: string | null }[] = before.filter((e) => keys.has(e.key) || removed.includes(e.key)).map((e) => ({ key: e.key, data: e.data }));
          const beforeKeys = new Set(before.map((e) => e.key));
          for (const e of committed) if (!beforeKeys.has(e.key)) guards.push({ key: e.key, data: null });
          try { await save(committed, removed, guards); break; }
          catch (error) {
            await ensureActive();
            if (attempt === 2) throw error;
          }
        }
        for (const e of committed) if (!await localCacheDriver.get(userId, e.key)) throw new Error('Проверка локального snapshot не пройдена.');
        meta.basic_ready = BASIC_DATASETS.every((name) => meta.datasets[name]?.status === 'complete') && meta.assets_ready;
        meta.extended_ready = meta.scheme === 'extended' && requiredDatasets('extended').every((name) => meta.datasets[name]?.status === 'complete') && meta.assets_ready;
        meta.offline_ready = meta.scheme === 'basic' ? meta.basic_ready : meta.extended_ready;
        meta.status = meta.offline_ready ? 'ready' : 'partial';
        meta.completed_at = new Date().toISOString(); meta.last_successful_sync_at = meta.completed_at;
        meta.retry = null;
        // Old staging revisions are disposable; outbox/conflicts are separate.
        const retained = new Set<string>();
        for (const name of Object.keys(meta.datasets) as Dataset[]) {
          const state = meta.datasets[name]!;
          for (let offset = 0; offset < state.count; offset += PAGE_SIZE) retained.add(batchKey(name, state.revision, offset));
        }
        const obsolete = (await localCacheDriver.listEntries(userId, 'bootstrap:batch:')).filter((e) => !retained.has(e.key)).map((e) => e.key);
        await save([], obsolete);
        break;
      } catch (error) {
        if (snapshotConflict(error) && restart < 2) continue;
        throw error;
      }
    }
  } catch (error) {
    if (await activeCacheUserId() !== userId || (cancellations.get(userId) ?? 0) !== cancellation) return;
    const current = await getBootstrapMetadata(userId);
    if (current.lease?.owner !== owner) return;
    meta.offline_ready = false;
    const failures = Math.min(6, (meta.retry?.failures ?? 0) + 1);
    const backoff = Math.min(MAX_BACKOFF_MS, BOOTSTRAP_COALESCE_MS * 2 ** (failures - 1) * (0.8 + Math.random() * 0.4));
    meta.retry = { failures, next_retry_at: Date.now() + Math.ceil(backoff) };
    meta.status = Object.values(meta.datasets).some((d) => d.status === 'complete') ? 'partial' : 'error';
    meta.error = snapshotConflict(error) ? 'Данные изменились во время подготовки. Повторим подготовку после паузы.'
      : isTransportFailure(error) ? 'Нет подключения. Подготовка продолжится после восстановления сети.'
      : error instanceof Error ? error.message : 'Не удалось подготовить офлайн-данные.';
    for (const state of Object.values(meta.datasets)) if (state.status === 'loading') { state.status = 'error'; state.error = meta.error; }
    let remove: string[] = [];
    if (isExplicitAccessError(error)) {
      meta.basic_ready = false; meta.extended_ready = false; meta.datasets = {};
      remove = (await localCacheDriver.listEntries(userId)).filter((e) => e.key !== BOOTSTRAP_KEY && !e.key.startsWith('sync:')).map((e) => e.key);
    }
    await save([], remove);
  } finally {
    const current = await getBootstrapMetadata(userId);
    if (current.lease?.owner === owner) {
      current.lease = null;
      const saved = await localCacheDriver.get(userId, BOOTSTRAP_KEY);
      if (saved && (JSON.parse(saved.data) as BootstrapMetadata).lease?.owner === owner)
        await writeMeta(current, saved.data).catch(() => undefined);
    }
  }
}

export function runAccountBootstrap(userId: string, force = false, assets = prepareOfflineAssets): Promise<RunResult> {
  const existing = inFlight.get(userId);
  if (existing) return existing;
  const task = (async (): Promise<RunResult> => {
    // Share the existing sync lock; confirmed snapshots and pull pages cannot
    // overwrite each other. IndexedDB leases/CAS cover the fallback browsers.
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      // Passive tabs never queue forced duplicate bootstraps behind the owner.
      let acquired = false;
      await navigator.locks.request(`tasktrace-sync:${userId}`, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        acquired = true;
        await bootstrap(userId, force, assets);
      });
      return acquired ? 'settled' : 'busy';
    }
    await bootstrap(userId, force, assets);
    return 'settled';
  })().finally(() => { inFlight.delete(userId); });
  inFlight.set(userId, task);
  return task;
}
