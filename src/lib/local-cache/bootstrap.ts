import { supabase } from '@/lib/supabase/client';
import { browserIsOffline, revalidateConnectivity, usesLocalReads } from '@/lib/connectivity/state';
import { boundedOperation } from '@/lib/connectivity/deadline';
import { activeCacheUserId, isExplicitAccessError, isTransportFailure } from './cache';
import { localCacheDriver } from './driver';
import { newOperationId } from './uuid';
import { accountReadModels, cacheEntry, type AccountRows } from './bootstrap-models';
import { BASIC_DATASETS, BOOTSTRAP_KEY, OFFLINE_BOOTSTRAP_VERSION, batchKey, bootstrapProgress,
  initialBootstrap, requiredDatasets, type AccountManifest, type BootstrapMetadata, type Dataset, type OfflineScheme } from './bootstrap-types';
import type { CacheEntry } from './types';
import { getUtcPlus3DayStart } from './day';
import { getOfflineRuntime, startRuntimeOperation, cancelRuntimeOperation, publishBootstrapFacts, subscribeOfflineRuntime, type OperationTicket } from './runtime-state';
import { requestOfflineWork } from './work-requests';
import { announceReadModelCommit } from './read-model-events';
import { cacheAccessDecision, cacheAccessEpoch, confirmCacheAccess, deniedSince, denyCacheAccess } from './access-state';

const PAGE_SIZE = 500;
const LEASE_MS = 45_000;
export const BOOTSTRAP_REFRESH_MS = 5 * 60_000;
export const BOOTSTRAP_COALESCE_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
type RunResult = 'settled' | 'busy';
export const BOOTSTRAP_OPERATION_TIMEOUT_MS = 20_000;
const inFlight = new Map<string, { controller: AbortController; promise: Promise<RunResult> }>();
const cancellations = new Map<string, number>();
const ownedLeases = new Map<string, string>();
const reads = new Map<string, number>();
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
  broadcast(); listeners.add(listener);
  const observed = new Map<string, string>();
  const runtime = subscribeOfflineRuntime((id) => {
    if (!id) return;
    const fingerprint = JSON.stringify(getOfflineRuntime(id).operations.preparation ?? null);
    if (observed.get(id) === fingerprint) return;
    observed.set(id, fingerprint); listener(id);
  });
  return () => { listeners.delete(listener); runtime(); };
}
export function cancelAccountBootstrap(userId: string): void {
  cancellations.set(userId, (cancellations.get(userId) ?? 0) + 1);
  inFlight.get(userId)?.controller.abort();
  cancelRuntimeOperation(userId, 'preparation');
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
async function readMetadata(userId: string): Promise<BootstrapMetadata> {
  const entry = await boundedOperation(() => localCacheDriver.get(userId, BOOTSTRAP_KEY), BOOTSTRAP_OPERATION_TIMEOUT_MS);
  if (!entry) return initialBootstrap(userId);
  const value = JSON.parse(entry.data) as BootstrapMetadata;
  if (value.user_id !== userId || value.schema_version !== OFFLINE_BOOTSTRAP_VERSION) return initialBootstrap(userId);
  // Normalize before every early return, including a day rollover.
  if (value.status === 'running' || value.status === 'updating') {
    value.status = value.basic_ready && (value.scheme === 'basic' || value.extended_ready) ? 'ready' : 'partial';
  }
  if (value.manifest && new Date(value.manifest.day_start).toISOString() !== getUtcPlus3DayStart()) {
    const stale: BootstrapMetadata = { ...value, status: 'partial',
      offline_ready: false, basic_ready: false, extended_ready: false,
      datasets: { ...value.datasets, ...(value.datasets.daily_audit ? { daily_audit: { ...value.datasets.daily_audit, status: 'pending' as const, offset: 0 } } : {}) },
      error: 'Наступил новый день. Подключитесь к сети, чтобы обновить дневной прогресс.' };
    stale.progress = bootstrapProgress(stale);
    return stale;
  }
  return value;
}
export async function getBootstrapMetadata(userId: string): Promise<BootstrapMetadata> {
  const sequence = (reads.get(userId) ?? 0) + 1; reads.set(userId, sequence);
  const epoch = getOfflineRuntime(userId).epoch;
  const meta = await readMetadata(userId);
  const verified = await boundedOperation(() => verifyLocalReadiness(meta), BOOTSTRAP_OPERATION_TIMEOUT_MS);
  const value = { ...meta, ...verified };
  const operation = getOfflineRuntime(userId).operations.preparation;
  const pipeline = getOfflineRuntime(userId).operations.pipeline;
  const selectedReady = value.scheme === 'basic' ? value.basic_ready : value.extended_ready;
  if (operation?.phase === 'running' && operation.visible) value.status = value.completed_at ? 'updating' : 'running';
  else if (selectedReady) value.status = 'ready';
  else if (value.status === 'ready') value.status = 'partial';
  if (operation?.phase === 'settled' && operation.outcome === 'error' && !value.error) {
    value.error = operation.error; if (!selectedReady) value.status = 'error';
  }
  if (!selectedReady && operation?.phase !== 'running' && pipeline?.phase === 'settled') {
    if (pipeline.outcome === 'waiting-network') value.status = 'offline_waiting';
    else if (pipeline.outcome === 'error') { value.status = 'error'; value.error = pipeline.error ?? value.error; }
  }
  value.progress = bootstrapProgress(value);
  if (reads.get(userId) === sequence && getOfflineRuntime(userId).epoch === epoch) publishBootstrapFacts(userId, value);
  return value;
}
function persistedMetadata(meta: BootstrapMetadata): BootstrapMetadata {
  const stable = JSON.parse(JSON.stringify(meta)) as BootstrapMetadata;
  if (stable.status === 'running' || stable.status === 'updating' || stable.status === 'ready') {
    stable.status = stable.basic_ready && (stable.scheme === 'basic' || stable.extended_ready) ? 'ready' : 'partial';
  }
  stable.started_at = null;
  for (const dataset of Object.values(stable.datasets)) if (dataset.status === 'loading') dataset.status = 'pending';
  stable.progress = bootstrapProgress(stable);
  return stable;
}
async function writeMeta(meta: BootstrapMetadata, baseline: string | null, entries: CacheEntry[] = [], remove: string[] = [], guards: { key: string; data: string | null }[] = [], signal?: AbortSignal): Promise<string> {
  meta.progress = bootstrapProgress(meta);
  const stable = persistedMetadata(meta);
  if (!await boundedOperation((deadline) => localCacheDriver.commitCacheBatch(meta.user_id, [...entries, cacheEntry(meta.user_id, BOOTSTRAP_KEY, stable)], remove,
    [{ key: BOOTSTRAP_KEY, data: baseline }, ...guards], deadline), BOOTSTRAP_OPERATION_TIMEOUT_MS, signal).catch(localStorageError)) throw new Error('Bootstrap lease changed');
  announce(meta.user_id);
  return JSON.stringify(stable);
}
function localStorageError(error: unknown): never {
  if ((error as Error)?.name === 'TimeoutError') throw Object.assign(new Error('Локальная операция не завершилась. Повторим попытку.'), { code: 'LOCAL_STORAGE' });
  throw error;
}
export async function selectOfflineScheme(userId: string, scheme: OfflineScheme): Promise<void> {
  if (await activeCacheUserId() !== userId) throw new Error('Сеанс изменился.');
  if (scheme !== 'basic' && scheme !== 'extended') throw new Error('Некорректная схема офлайн-режима.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const entry = await localCacheDriver.get(userId, BOOTSTRAP_KEY);
    const meta = await getBootstrapMetadata(userId);
    if (meta.scheme === scheme && entry) return;
    meta.scheme = scheme; meta.lease = null; meta.error = null;
    for (const state of Object.values(meta.datasets)) if (state.status === 'pending' || state.status === 'loading') state.status = 'cancelled';
    meta.offline_ready = meta.basic_ready;
    meta.status = meta.basic_ready && (scheme === 'basic' || meta.extended_ready) ? 'ready' : 'partial';
    meta.progress = bootstrapProgress(meta);
    if (await localCacheDriver.commitCacheBatch(userId, [cacheEntry(userId, BOOTSTRAP_KEY, persistedMetadata(meta))], [], [{ key: BOOTSTRAP_KEY, data: entry?.data ?? null }])) {
      cancelAccountBootstrap(userId); announce(userId);
      if (usesLocalReads()) return;
      void (requestOfflineWork(userId, 'scheme') ?? retryAccountBootstrap(userId)).catch(() => undefined);
      return;
    }
  }
  throw new Error('Не удалось сохранить настройку. Повторите выбор.');
}

function validateManifest(value: unknown, userId: string, scheme: OfflineScheme): AccountManifest {
  const invalid = (message: string) => Object.assign(new Error(message), { name: 'InvalidSnapshotError' });
  const manifest = value as AccountManifest | null;
  if (!manifest || manifest.user_id !== userId || manifest.schema_version !== OFFLINE_BOOTSTRAP_VERSION
    || !Number.isFinite(Date.parse(manifest.day_start)) || !Number.isFinite(Date.parse(manifest.generated_at))
    || !Number.isFinite(Date.parse(manifest.history_start))) throw invalid('Некорректный snapshot аккаунта.');
  if (manifest.snapshot_at !== undefined && (typeof manifest.snapshot_at !== 'string' || !Number.isFinite(Date.parse(manifest.snapshot_at))))
    throw invalid('Некорректная граница snapshot.');
  for (const name of requiredDatasets(scheme)) {
    const dataset = manifest.datasets?.[name];
    if (!dataset && !(BASIC_DATASETS as readonly string[]).includes(name)) continue;
    if (!dataset || !Number.isSafeInteger(dataset.count) || dataset.count < 0 || !/^[a-f0-9]{32}$/.test(dataset.revision))
      throw invalid('Отсутствует обязательный набор данных.');
    if (!Array.isArray(dataset.pages) || dataset.pages.length !== Math.ceil(dataset.count / PAGE_SIZE)
      || dataset.pages.some((hash) => !/^[a-f0-9]{32}$/.test(hash))) throw invalid('Некорректные версии страниц snapshot.');
  }
  if (manifest.datasets.profile?.count !== 1) throw invalid('Не найден профиль пользователя.');
  // Preserve snapshot_at verbatim: Date/toISOString would truncate Postgres
  // microseconds and subtly change the server's membership window.
  return { ...manifest, day_start: new Date(manifest.day_start).toISOString(),
    generated_at: new Date(manifest.generated_at).toISOString(), history_start: new Date(manifest.history_start).toISOString() };
}
async function manifestFor(userId: string, scheme: OfflineScheme, snapshotAt?: string, signal?: AbortSignal): Promise<AccountManifest> {
  const { data, error } = await boundedOperation((deadline) => supabase.rpc('get_offline_account_manifest',
    { p_scheme: scheme, ...(snapshotAt ? { p_snapshot_at: snapshotAt } : {}) }).abortSignal(deadline), BOOTSTRAP_OPERATION_TIMEOUT_MS, signal);
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
    const expected = meta.verified?.basic?.batches?.[entry.key] ?? meta.verified?.extended?.batches?.[entry.key];
    if (expected !== undefined && expected !== checksum(entry.data)) throw new Error('Сохранённый batch повреждён.');
    const page: unknown = JSON.parse(entry.data);
    if (!Array.isArray(page) || page.length !== Math.min(PAGE_SIZE, state.count - offset)) throw new Error('Сохранённый batch повреждён.');
    rows.push(...page);
  }
  return rows;
}

// Certificates come from final server verification + atomic read-model commit.
// Recheck actual user-scoped batches, models and PWA files on every restoration;
// neither a legacy ready boolean nor an expired runtime operation is sufficient.
async function verifyLocalReadiness(meta: BootstrapMetadata): Promise<Pick<BootstrapMetadata, 'basic_ready' | 'extended_ready' | 'offline_ready' | 'assets_ready'>> {
  const empty = { basic_ready: false, extended_ready: false, offline_ready: false, assets_ready: false };
  if (!meta.manifest && !meta.verified?.basic) return empty;
  const entries = await localCacheDriver.listEntries(meta.user_id);
  const stored = new Map(entries.filter((e) => e.user_id === meta.user_id && e.schema_version === 1).map((e) => [e.key, e]));
  const check = (scheme: OfflineScheme): boolean => {
    const certificate = meta.verified?.[scheme];
    const manifest = certificate?.manifest ?? (meta[scheme === 'basic' ? 'basic_ready' : 'extended_ready'] ? meta.manifest : null);
    if (!manifest || manifest.user_id !== meta.user_id || manifest.day_start !== getUtcPlus3DayStart()) return false;
    try {
      validateManifest(manifest, meta.user_id, scheme);
      const rows: AccountRows = {};
      for (const name of requiredDatasets(scheme)) {
        const version = manifest.datasets[name]; if (!version) return false;
        const values: unknown[] = [];
        for (let offset = 0; offset < version.count; offset += PAGE_SIZE) {
          const entry = stored.get(batchKey(name, version.revision, offset)); if (!entry) return false;
          if (certificate?.batches && certificate.batches[entry.key] !== checksum(entry.data)) return false;
          const page: unknown = JSON.parse(entry.data);
          if (!Array.isArray(page) || page.length !== Math.min(PAGE_SIZE, version.count - offset)) return false;
          values.push(...page);
        }
        rows[name] = values;
      }
      if ((rows.profile?.[0] as { id?: string })?.id !== meta.user_id) return false;
      const expected = accountReadModels(meta.user_id, rows, manifest, entries.filter((e) => e.key.startsWith('items:')));
      if (certificate && expected.some((entry) => !certificate.models.includes(entry.key))) return false;
      return expected.every((entry) => {
        const value = stored.get(entry.key);
        // Authorized foreground reads clear negative-access markers. Missing
        // `blocked=false` is equivalent to false, while a denial remains binding.
        if (/^blocked(?:-task)?:/.test(entry.key)) {
          if (cacheAccessDecision(meta.user_id, entry.key) === true) return false;
          if (!value && entry.data === 'false') return true;
        }
        if (!value) return false;
        return modelCovers(JSON.parse(value.data), JSON.parse(entry.data));
      });
    } catch { return false; }
  };
  const basic = check('basic');
  const assets = basic && await prepareOfflineAssets();
  return { basic_ready: basic && assets, extended_ready: basic && assets && check('extended'), offline_ready: basic && assets, assets_ready: assets };
}

function modelCovers(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual === null || typeof actual === 'string';
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    const byId = new Map(actual.filter((row) => row && typeof row === 'object' && 'id' in row).map((row) => [row.id, row]));
    return expected.every((row, index) => modelCovers(row && typeof row === 'object' && 'id' in row ? byId.get(row.id) : actual[index], row));
  }
  if (typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const value = actual as Record<string, unknown>;
    return Object.entries(expected).every(([key, item]) => ['id', 'task_id', 'project_id', 'template_id'].includes(key)
      ? value[key] === item : modelCovers(value[key], item));
  }
  return typeof expected === 'boolean' ? actual === expected : typeof actual === typeof expected;
}
function checksum(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16);
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

async function bootstrap(userId: string, force: boolean, assets: () => Promise<boolean>, signal: AbortSignal, ticket: OperationTicket): Promise<void> {
  const step = <T,>(work: () => Promise<T>) => boundedOperation(work, BOOTSTRAP_OPERATION_TIMEOUT_MS, signal).catch(localStorageError);
  if (await step(activeCacheUserId) !== userId) return;
  const entry = await step(() => localCacheDriver.get(userId, BOOTSTRAP_KEY));
  let meta = await step(() => getBootstrapMetadata(userId));
  ticket.assertCurrent();
  ticket.update({ visible: !(meta.scheme === 'basic' ? meta.basic_ready : meta.extended_ready) });
  if (usesLocalReads()) {
    if (!meta.basic_ready) {
      meta.status = 'offline_waiting'; meta.lease = null;
      meta.error = 'Нет подключения. Подготовка продолжится после восстановления сети.';
      for (const state of Object.values(meta.datasets)) if (state.status === 'pending' || state.status === 'loading') state.status = 'cancelled';
      await writeMeta(meta, entry?.data ?? null, [], [], [], signal);
    }
    return;
  }
  // Shared durable gates apply to every trigger, including force/reconnect.
  // A new tab or repeated connected status cannot reset a failed run's backoff.
  if (bootstrapDelay(meta) > 0) return;
  if (!force && meta.status === 'ready' && meta.last_successful_sync_at
    && Date.now() - Date.parse(meta.last_successful_sync_at) < BOOTSTRAP_REFRESH_MS) return;
  const owner = newOperationId();
  ownedLeases.set(userId, owner);
  const cancellation = cancellations.get(userId) ?? 0;
  const ensureActive = async () => {
    if (signal.aborted || await step(activeCacheUserId) !== userId || (cancellations.get(userId) ?? 0) !== cancellation) throw new Error('Bootstrap cancelled');
    ticket.assertCurrent();
    const current = await step(() => readMetadata(userId));
    if (current.lease?.owner !== owner) throw new Error('Bootstrap lease changed');
  };
  let baseline = entry?.data ?? null;
  const save = async (entries: CacheEntry[] = [], remove: string[] = [], guards: { key: string; data: string | null }[] = []) => {
    await ensureActive();
    if (meta.lease) meta.lease.expires_at = Date.now() + LEASE_MS;
    baseline = await writeMeta(meta, baseline, entries, remove, guards, signal);
  };
  // Acquiring a lease/reading an unchanged manifest is background maintenance.
  meta = { ...meta, status: meta.basic_ready ? 'ready' : 'running', error: null,
    started_at: new Date().toISOString(), last_attempt_at: Date.now(), lease: { owner, expires_at: Date.now() + LEASE_MS } };
  try { baseline = await writeMeta(meta, baseline, [], [], [], signal); }
  catch (error) {
    if (ticket.current() && !(error instanceof Error && error.message === 'Bootstrap lease changed')) {
      // A failed initial write has no durable metadata. Its error belongs to
      // the live operation record, never a second volatile status snapshot.
      ticket.finish('error', 'Не удалось записать данные в локальное хранилище.');
      announce(userId);
    }
    return; // A competing lease or unavailable local storage.
  }
  try {
    for (let restart = 0; restart < 3; restart++) {
      try {
        // Fence the server snapshot before its first request. A pull in another
        // tab can change membership as well as versions, including tombstones.
        const snapshotBaseline = new Map((await step(() => localCacheDriver.listEntries(userId))).map((e) => [e.key, e.data]));
        const accessBaseline = cacheAccessEpoch();
        const manifest = await manifestFor(userId, meta.scheme, undefined, signal);
        await ensureActive();
        meta.manifest = manifest;
        const reusable: Partial<Record<Dataset, Map<number, string>>> = {};
        for (const name of requiredDatasets(meta.scheme)) {
          const version = manifest.datasets[name]!;
          const old = meta.datasets[name];
          if (!version) {
            meta.datasets[name] = { revision: '0'.repeat(32), count: 0, pages: [], offset: 0, status: 'skipped', error: 'Дополнительный набор отсутствует в manifest.' };
            meta.extended_ready = false;
            continue;
          }
          // Inventory pages before downloading. A missing/corrupt page does
          // not discard the intact pages of the same dataset, and interrupted
          // offsets cannot conceal an earlier page evicted from IndexedDB.
          const pages = new Map<number, string>();
          for (let offset = 0; offset < version.count; offset += PAGE_SIZE) {
            const candidates = [batchKey(name, version.revision, offset)];
            if (old?.pages[offset / PAGE_SIZE] === version.pages[offset / PAGE_SIZE])
              candidates.push(batchKey(name, old.revision, offset));
            for (const key of candidates) {
              const data = snapshotBaseline.get(key);
              if (!data) continue;
              const expected = meta.verified?.basic?.batches?.[key] ?? meta.verified?.extended?.batches?.[key];
              if (expected !== undefined && expected !== checksum(data)) continue;
              try {
                const page: unknown = JSON.parse(data);
                if (!Array.isArray(page) || page.length !== Math.min(PAGE_SIZE, version.count - offset)) continue;
                pages.set(offset, data); break;
              } catch { /* Invalid staging pages must be fetched again. */ }
            }
          }
          reusable[name] = pages;
          const complete = old?.revision === version.revision && old.count === version.count
            && old.status === 'complete' && pages.size === version.pages.length;
          meta.datasets[name] = { ...version, offset: complete ? version.count : 0, status: complete ? 'complete' : 'pending' };
          if (!complete) {
            if ((BASIC_DATASETS as readonly string[]).includes(name)) meta.basic_ready = false;
            meta.extended_ready = false;
          }
        }
        meta.offline_ready = meta.basic_ready;
        if (!meta.basic_ready || (meta.scheme === 'extended' && !meta.extended_ready)) meta.status = meta.completed_at ? 'updating' : 'running';
        await save();
        const commitModels = async (verified: AccountManifest, names: Dataset[], scheme: OfflineScheme) => {
          const rows: AccountRows = {};
          for (const name of names) rows[name] = await step(() => readDataset(userId, name, meta));
          let committed: CacheEntry[] = [];
          for (let attempt = 0; attempt < 3; attempt++) {
            const before = await step(() => localCacheDriver.listEntries(userId));
            committed = accountReadModels(userId, rows, verified, before);
            const keys = new Set(committed.map((e) => e.key));
            const removed = before.filter((e) => /^(task-overrides:|template:|template-items:|daily-audit:)/.test(e.key) && !keys.has(e.key)).map((e) => e.key);
            const guards: { key: string; data: string | null }[] = before.filter((e) => keys.has(e.key) || removed.includes(e.key)).map((e) => ({ key: e.key, data: e.data }));
            const beforeKeys = new Set(before.map((e) => e.key));
            for (const e of committed) if (!beforeKeys.has(e.key)) guards.push({ key: e.key, data: null });
            guards.push({ key: 'sync:task-items:cursor', data: snapshotBaseline.get('sync:task-items:cursor') ?? null });
            for (const guard of guards) if (/^(items:|task-stats:|last-editors:)/.test(guard.key))
              guard.data = snapshotBaseline.get(guard.key) ?? null;
            for (const e of committed) if (/^blocked(?:-task)?:/.test(e.key)) {
              if (e.data === 'true') denyCacheAccess(userId, e.key);
              else if (deniedSince(userId, e.key, accessBaseline)) throw Object.assign(new Error('Access changed during snapshot'), { code: '40001' });
              const guard = guards.find((g) => g.key === e.key);
              if (guard) guard.data = snapshotBaseline.get(e.key) ?? null;
            }
            const batchEntries = new Map(before.map((e) => [e.key, e]));
            const batches: Record<string, string> = {};
            for (const name of names) {
              const version = verified.datasets[name]!;
              for (let offset = 0; offset < version.count; offset += PAGE_SIZE) {
                const key = batchKey(name, version.revision, offset); const entry = batchEntries.get(key);
                if (!entry) throw new Error('Сохранённый batch отсутствует.');
                batches[key] = checksum(entry.data);
              }
            }
            const evidence = { manifest: verified, models: committed.map((e) => e.key), batches };
            const previousEvidence = meta.verified;
            meta.verified = { basic: previousEvidence?.basic ?? null, extended: previousEvidence?.extended ?? null, [scheme]: evidence };
            if (scheme === 'basic' && previousEvidence?.extended && BASIC_DATASETS.some((name) =>
              previousEvidence.extended!.manifest.datasets[name]?.revision !== verified.datasets[name]?.revision)) meta.verified.extended = null;
            try {
              await save(committed, removed, guards);
              for (const entry of committed) snapshotBaseline.set(entry.key, entry.data);
              for (const entry of committed) if (/^blocked(?:-task)?:/.test(entry.key) && entry.data === 'false') confirmCacheAccess(userId, entry.key, accessBaseline);
              announceReadModelCommit(userId, committed.map((entry) => entry.key), 'preparation');
              break;
            } catch (error) {
              meta.verified = previousEvidence; await ensureActive();
              // Re-reading the CAS baseline would bless the same stale snapshot.
              // Restart from a new server manifest instead.
              throw Object.assign(new Error('Local snapshot changed during preparation'), { code: '40001', cause: error });
            }
          }
          for (const e of committed) if (!await step(() => localCacheDriver.get(userId, e.key))) throw new Error('Проверка локального snapshot не пройдена.');
        };
        let optionalError: string | null = Object.values(meta.datasets).some((state) => state.status === 'skipped')
          ? 'Базовые данные готовы. Некоторые дополнительные наборы отсутствуют.' : null;
        let optionalTransportFailure = false;
        for (const name of requiredDatasets(meta.scheme)) {
          const state = meta.datasets[name]!;
          if (state.status !== 'complete' && state.status !== 'skipped') {
            try {
              state.status = 'loading'; delete state.error;
              await save();
              while (state.offset < state.count) {
                await ensureActive();
                const offset = state.offset;
                const reusablePage = reusable[name]?.get(offset);
                if (reusablePage) {
                  const page = JSON.parse(reusablePage) as unknown[];
                  state.offset += page.length;
                  await save([cacheEntry(userId, batchKey(name, state.revision, offset), page)]);
                  continue;
                }
                const { data, error } = await boundedOperation((deadline) => supabase.rpc('get_offline_account_page', { p_dataset: name, p_revision: state.revision,
                  p_offset: offset, p_limit: PAGE_SIZE, ...(manifest.snapshot_at ? { p_snapshot_at: manifest.snapshot_at } : {}) }).abortSignal(deadline), BOOTSTRAP_OPERATION_TIMEOUT_MS, signal);
                if (error) throw error;
                const page = data as { revision: string; total: number; offset: number; rows: unknown[] } | null;
                if (!page || page.revision !== state.revision || page.total !== state.count || page.offset !== offset
                  || !Array.isArray(page.rows) || page.rows.length !== Math.min(PAGE_SIZE, state.count - offset)) throw new Error('Неполная страница snapshot.');
                state.offset += page.rows.length;
                await save([cacheEntry(userId, batchKey(name, state.revision, offset), page.rows)]);
              }
              state.status = 'complete'; await save();
              const savedRows = await step(() => readDataset(userId, name, meta));
              const visible = await step(() => visibilityEntries(userId, name, savedRows));
              let revokedOverrides: string[] = [];
              if (name === 'projects') {
                const administrators = new Set((savedRows as { id: string; role: string }[])
                  .filter((p) => p.role === 'owner' || p.role === 'admin').map((p) => p.id));
                revokedOverrides = (await step(() => localCacheDriver.listEntries(userId, 'task:'))).flatMap((e) => {
                  const task = JSON.parse(e.data) as { id: string; project_id: string };
                  return administrators.has(task.project_id) ? [] : [`task-overrides:${task.id}`];
                });
              }
              if (visible.length || revokedOverrides.length) {
                const visibilityGuards = visible.filter((e) => /^(blocked(?:-task)?:|project:|task:|task-role:)/.test(e.key))
                  .map((e) => ({ key: e.key, data: snapshotBaseline.get(e.key) ?? null }));
                for (const e of visible) if (/^blocked(?:-task)?:/.test(e.key)) {
                  if (e.data === 'true') denyCacheAccess(userId, e.key);
                  else if (deniedSince(userId, e.key, accessBaseline)) throw Object.assign(new Error('Access changed during snapshot'), { code: '40001' });
                }
                try { await save(visible, revokedOverrides, visibilityGuards); }
                catch (error) { throw Object.assign(new Error('Visibility changed during snapshot'), { code: '40001', cause: error }); }
                for (const e of visible) snapshotBaseline.set(e.key, e.data);
              }
            } catch (error) {
              if ((BASIC_DATASETS as readonly string[]).includes(name) || snapshotConflict(error) || isExplicitAccessError(error) || signal.aborted) throw error;
              await ensureActive();
              state.status = 'error'; state.error = error instanceof Error ? error.message : 'Дополнительные данные недоступны.';
              optionalTransportFailure ||= isTransportFailure(error);
              const title = name === 'history' ? 'историю' : name === 'notifications' ? 'уведомления' : 'авторов изменений';
              optionalError = `Не удалось сохранить ${title}. Базовые данные готовы; дополнительные данные можно загрузить повторно.`;
              await save();
            }
          }
          // Verify and commit mandatory models before optional resources start.
          if (name === 'daily_audit') {
            meta.assets_ready = await step(assets);
            if (!meta.assets_ready) { meta.basic_ready = false; meta.extended_ready = false; throw new Error('Файлы приложения ещё не сохранены для офлайн-режима.'); }
            const basic = await manifestFor(userId, 'basic', manifest.snapshot_at, signal);
            if (BASIC_DATASETS.some((dataset) => basic.datasets[dataset]!.revision !== meta.datasets[dataset]!.revision))
              throw { code: '40001', message: 'Snapshot changed during verification' };
            await commitModels(basic, [...BASIC_DATASETS], 'basic');
            meta.basic_ready = true; meta.offline_ready = true;
            await save();
          }
        }
        if (meta.scheme === 'extended' && !optionalError) {
          const verified = await manifestFor(userId, meta.scheme, manifest.snapshot_at, signal);
          if (requiredDatasets(meta.scheme).some((name) => verified.datasets[name]!.revision !== meta.datasets[name]!.revision))
            throw { code: '40001', message: 'Snapshot changed during verification' };
          await commitModels(verified, requiredDatasets(meta.scheme), 'extended');
          meta.manifest = verified; meta.extended_ready = true;
        }
        meta.offline_ready = meta.basic_ready;
        meta.status = meta.scheme === 'extended' && !meta.extended_ready ? 'partial' : 'ready'; meta.error = optionalError;
        meta.completed_at = new Date().toISOString(); meta.last_successful_sync_at = meta.completed_at;
        meta.retry = optionalError ? { failures: 1, next_retry_at: Date.now() + BOOTSTRAP_REFRESH_MS, reason: optionalTransportFailure ? 'transport' : 'optional' } : null;
        // Old staging revisions are disposable; outbox/conflicts are separate.
        const retained = new Set<string>();
        for (const name of Object.keys(meta.datasets) as Dataset[]) {
          const state = meta.datasets[name]!;
          for (let offset = 0; offset < state.count; offset += PAGE_SIZE) retained.add(batchKey(name, state.revision, offset));
        }
        for (const evidence of Object.values(meta.verified ?? {})) if (evidence) {
          for (const [name, version] of Object.entries(evidence.manifest.datasets)) {
            for (let offset = 0; offset < version.count; offset += PAGE_SIZE) retained.add(batchKey(name as Dataset, version.revision, offset));
          }
        }
        const obsolete = (await step(() => localCacheDriver.listEntries(userId, 'bootstrap:batch:'))).filter((e) => !retained.has(e.key)).map((e) => e.key);
        await save([], obsolete);
        break;
      } catch (error) {
        if (snapshotConflict(error) && restart < 2) continue;
        throw error;
      }
    }
  } catch (error) {
    if (signal.aborted || await step(activeCacheUserId) !== userId || (cancellations.get(userId) ?? 0) !== cancellation) return;
    const current = await readMetadata(userId);
    if (current.lease?.owner !== owner) return;
    if ((error as Error)?.name === 'InvalidSnapshotError') {
      meta.basic_ready = false; meta.extended_ready = false; meta.verified = { basic: null, extended: null };
    }
    meta.offline_ready = meta.basic_ready;
    const failures = Math.min(6, (meta.retry?.failures ?? 0) + 1);
    const backoff = Math.min(MAX_BACKOFF_MS, BOOTSTRAP_COALESCE_MS * 2 ** (failures - 1) * (0.8 + Math.random() * 0.4));
    meta.retry = { failures, next_retry_at: Date.now() + Math.ceil(backoff), ...(isTransportFailure(error) ? { reason: 'transport' as const } : {}) };
    meta.status = meta.basic_ready ? 'ready' : isTransportFailure(error) ? 'offline_waiting'
      : Object.values(meta.datasets).some((d) => d.status === 'complete') ? 'partial' : 'error';
    meta.error = snapshotConflict(error) ? 'Данные изменились во время подготовки. Повторим подготовку после паузы.'
      : isTransportFailure(error) ? 'Нет подключения. Подготовка продолжится после восстановления сети.'
      : error instanceof Error ? error.message : 'Не удалось подготовить офлайн-данные.';
    for (const state of Object.values(meta.datasets)) {
      if (state.status === 'loading') { state.status = 'error'; state.error = meta.error; }
      else if (state.status === 'pending') state.status = 'cancelled';
    }
    let remove: string[] = [];
    if (isExplicitAccessError(error)) {
      meta.status = 'error'; meta.offline_ready = false; meta.basic_ready = false; meta.extended_ready = false; meta.datasets = {}; meta.verified = { basic: null, extended: null };
      remove = (await step(() => localCacheDriver.listEntries(userId))).filter((e) => e.key !== BOOTSTRAP_KEY && !e.key.startsWith('sync:')).map((e) => e.key);
    }
    await save([], remove);
  } finally {
    const current = await readMetadata(userId);
    if (current.lease?.owner === owner) {
      current.lease = null;
      if (!current.retry && !(current.basic_ready && (current.scheme === 'basic' || current.extended_ready))) {
        current.status = usesLocalReads() ? 'offline_waiting' : current.basic_ready ? 'ready' : 'partial';
        current.error = usesLocalReads() ? 'Нет подключения. Подготовка продолжится после восстановления сети.' : 'Подготовка отменена. Повторите попытку.';
        for (const state of Object.values(current.datasets)) if (state.status === 'pending' || state.status === 'loading') state.status = 'cancelled';
      }
      const saved = await boundedOperation(() => localCacheDriver.get(userId, BOOTSTRAP_KEY), BOOTSTRAP_OPERATION_TIMEOUT_MS);
      if (saved && (JSON.parse(saved.data) as BootstrapMetadata).lease?.owner === owner)
        await writeMeta(current, saved.data).catch(() => undefined);
    }
  }
}

export function runAccountBootstrap(userId: string, force = false, assets = prepareOfflineAssets): Promise<RunResult> {
  const existing = inFlight.get(userId);
  if (existing) return existing.promise;
  const controller = new AbortController();
  const ticket = startRuntimeOperation(userId, 'preparation', 'preparation', 10 * 60_000);
  ticket.signal.addEventListener('abort', () => controller.abort(), { once: true });
  const generation = cancellations.get(userId) ?? 0;
  const task = boundedOperation(async (): Promise<RunResult> => {
    // Share the existing sync lock; confirmed snapshots and pull pages cannot
    // overwrite each other. IndexedDB leases/CAS cover the fallback browsers.
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      // Passive tabs never queue forced duplicate bootstraps behind the owner.
      let acquired = false;
      await navigator.locks.request(`tasktrace-sync:${userId}`, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        acquired = true;
        ticket.assertCurrent();
        await bootstrap(userId, force, assets, controller.signal, ticket);
      });
      return acquired ? 'settled' : 'busy';
    }
    await bootstrap(userId, force, assets, controller.signal, ticket);
    return 'settled';
  }, 10 * 60_000).catch((error): RunResult => {
    if (ticket.current() && !controller.signal.aborted && (cancellations.get(userId) ?? 0) === generation) {
      ticket.finish('error', error instanceof Error ? error.message : 'Локальное хранилище недоступно.');
      announce(userId);
    }
    return 'settled';
  }).finally(async () => {
    if (inFlight.get(userId)?.promise === task) inFlight.delete(userId);
    if (!ticket.current()) return;
    try {
      const meta = await boundedOperation(() => getBootstrapMetadata(userId), BOOTSTRAP_OPERATION_TIMEOUT_MS, ticket.signal);
      ticket.finish(meta.scheme === 'basic' ? meta.basic_ready ? 'success' : usesLocalReads() ? 'waiting-network' : meta.error ? 'error' : 'partial'
        : meta.extended_ready ? 'success' : usesLocalReads() ? 'waiting-network' : meta.error ? 'error' : 'partial', meta.error);
    } catch (error) { ticket.finish('error', error instanceof Error ? error.message : 'Локальное хранилище недоступно.'); }
  });
  inFlight.set(userId, { controller, promise: task });
  return task;
}

export async function retryAccountBootstrap(userId: string, assets = prepareOfflineAssets): Promise<RunResult> {
  const previous = inFlight.get(userId);
  cancelAccountBootstrap(userId);
  const generation = cancellations.get(userId);
  if (previous) await boundedOperation(() => previous.promise, BOOTSTRAP_OPERATION_TIMEOUT_MS).catch(() => undefined);
  if (cancellations.get(userId) !== generation) return 'settled';
  if (inFlight.get(userId) === previous) inFlight.delete(userId);
  if (usesLocalReads() && !browserIsOffline()) await revalidateConnectivity(true);
  if (await boundedOperation(activeCacheUserId, BOOTSTRAP_OPERATION_TIMEOUT_MS) !== userId) return 'settled';
  for (let attempt = 0; attempt < 3; attempt++) {
    const entry = await boundedOperation(() => localCacheDriver.get(userId, BOOTSTRAP_KEY), BOOTSTRAP_OPERATION_TIMEOUT_MS);
    const meta = await getBootstrapMetadata(userId);
    if (cancellations.get(userId) !== generation) return 'settled';
    // A live foreign owner remains protected; expired leases can be recovered.
    if (meta.lease && meta.lease.owner !== ownedLeases.get(userId) && meta.lease.expires_at > Date.now()) return 'busy';
    meta.lease = null;
    meta.retry = null; delete meta.last_attempt_at;
    try { await writeMeta(meta, entry?.data ?? null); break; }
    catch (error) { if (attempt === 2) throw error; }
  }
  if (cancellations.get(userId) !== generation) return 'settled';
  return runAccountBootstrap(userId, true, assets);
}

export async function resumeAccountBootstrap(userId: string): Promise<RunResult> {
  const meta = await getBootstrapMetadata(userId);
  return meta.status === 'offline_waiting' || meta.retry?.reason === 'transport' ? retryAccountBootstrap(userId) : runAccountBootstrap(userId, true);
}
