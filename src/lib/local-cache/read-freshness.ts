import { localCacheDriver } from './driver';
import type { CacheEntry } from './types';

export const READ_FRESHNESS_MS = 60_000;
export const READ_MODEL_PREFIXES = ['projects:', 'project:', 'tasks:', 'task:', 'task-stats:', 'my-tasks:', 'items:',
  'members:', 'assignees:', 'task-role:', 'task-overrides:', 'last-editors:', 'audit:', 'daily-audit:',
  'templates', 'template:', 'template-items:', 'notifications:', 'profile:self'];
export type InvalidationKind = 'data' | 'refresh' | 'access';
type Wave = { version: number; prefixes: string[]; kind: InvalidationKind };
type Marker = { token: string; kind: InvalidationKind | 'confirmed'; aclToken?: string };
export const GLOBAL_ACL_KEY = 'read:acl:epoch';
export type DurableReadInvalidation = { entry: CacheEntry | null; global: CacheEntry | null; kind: InvalidationKind | null };
const waves = new Map<string, Map<string, Wave>>();
const confirmed = new Map<string, number>();
const persisting = new Map<string, Set<Promise<void>>>();
let version = 0;
export const readInvalidationEpoch = () => version;
let account: string | null = null;
let accountEpoch = 0;
export function setReadAccount(userId: string | null): void { if (account !== userId) accountEpoch += 1; account = userId; }
export const readAccountEpoch = () => accountEpoch;
export function currentReadAccount(): string | null { return account; }
export function isReadAccessPending(key: string): boolean { return !!account && readInvalidation(account, key).kind === 'access'; }
export const freshnessKey = (key: string) => `read:stale:${key}`;
const identity = (userId: string, key: string) => `${userId}:${key}`;
const matches = (key: string, prefixes: string[]) => prefixes.some((prefix) => key.startsWith(prefix));
export const isReadModelKey = (key: string) => matches(key, READ_MODEL_PREFIXES);

export function readInvalidation(userId: string, key: string): { version: number; kind: InvalidationKind | null } {
  let latest = 0; let kind: InvalidationKind | null = null;
  const partitions = /^items:.*:all$/.test(key) ? [`${key.slice(0, -3)}active`, `${key.slice(0, -3)}archived`] : [];
  for (const wave of waves.get(userId)?.values() ?? []) {
    const parts = partitions.filter((part) => matches(part, wave.prefixes));
    if (!matches(key, wave.prefixes) && !parts.length) continue;
    latest = Math.max(latest, wave.version);
    const baseline = Math.max(confirmed.get(identity(userId, key)) ?? 0,
      parts.length ? Math.min(...parts.map((part) => confirmed.get(identity(userId, part)) ?? 0)) : 0);
    if (wave.version <= baseline) continue;
    if (kind !== 'access') kind = wave.kind === 'access' ? 'access' : kind === 'refresh' ? 'refresh' : wave.kind;
  }
  return { version: latest, kind };
}
export function confirmReadFreshness(userId: string, key: string, baseline: number): void {
  confirmed.set(identity(userId, key), Math.max(confirmed.get(identity(userId, key)) ?? 0, baseline));
}
function storedMarkerInvalidation(stored: Map<string, CacheEntry>, key: string): DurableReadInvalidation {
  const entry = stored.get(freshnessKey(key)) ?? null;
  const global = stored.get(GLOBAL_ACL_KEY) ?? null;
  if (!entry) return { entry, global, kind: global ? 'access' : null };
  try {
    const value = JSON.parse(entry.data) as Marker;
    const kind = global && value.aclToken !== global.data ? 'access'
      : value.kind === 'confirmed' ? (global ? null : 'access')
      : ['data', 'refresh', 'access'].includes(value.kind) ? value.kind as InvalidationKind : 'access';
    return { entry, global, kind };
  } catch { return { entry, global, kind: 'access' }; }
}
export function storedReadInvalidation(stored: Map<string, CacheEntry>, key: string): DurableReadInvalidation {
  const own = storedMarkerInvalidation(stored, key);
  if (!/^items:.*:all$/.test(key)) return own;
  const parts = ['active', 'archived'].map((mode) => storedMarkerInvalidation(stored, `${key.slice(0, -3)}${mode}`));
  // The virtual union needs no additional global acknowledgement once both
  // canonical partitions have been confirmed. A scoped hard marker still binds.
  let scopedAccess = false;
  try { scopedAccess = !!own.entry && JSON.parse(own.entry.data).kind === 'access'; } catch { scopedAccess = true; }
  const kinds = [...parts.map((p) => p.kind), ...(own.kind !== 'access' || scopedAccess || !own.global ? [own.kind] : [])];
  return { ...own, kind: kinds.includes('access') ? 'access' : kinds.includes('refresh') ? 'refresh' : kinds.includes('data') ? 'data' : null };
}
export async function durableReadInvalidation(userId: string, key: string): Promise<DurableReadInvalidation> {
  const keys = [freshnessKey(key), GLOBAL_ACL_KEY, ...(/^items:.*:all$/.test(key) ? ['active', 'archived'].map((mode) => freshnessKey(`${key.slice(0, -3)}${mode}`)) : [])];
  const entries = await Promise.all(keys.map((key) => localCacheDriver.get(userId, key)));
  return storedReadInvalidation(new Map(entries.filter((e): e is CacheEntry => !!e).map((e) => [e.key, e])), key);
}
// The global fence stays in place. Each successful server read acknowledges
// exactly the captured token, atomically with its model and a guard on that token.
export function readConfirmationEntries(userId: string, keys: string[], global: CacheEntry | null): CacheEntry[] {
  return !global ? [] : keys.map((key) => ({ user_id: userId, key: freshnessKey(key),
    data: JSON.stringify({ token: global.data, aclToken: global.data, kind: 'confirmed' }),
    last_synced_at: new Date().toISOString(), schema_version: 1 }));
}
export function clearReadFreshness(): void { waves.clear(); confirmed.clear(); version += 1; }

export async function settleReadInvalidations(userId: string): Promise<void> {
  while (persisting.get(userId)?.size) await Promise.allSettled([...persisting.get(userId)!]);
}
export function invalidateReadModels(userId: string, prefixes = READ_MODEL_PREFIXES, kind: InvalidationKind = 'data'): Promise<void> {
  // The volatile fence is installed before IndexedDB I/O. Never allow a failed
  // persistence operation to bless cached data after an ACL signal.
  const wave: Wave = { version: ++version, prefixes, kind };
  const scope = waves.get(userId) ?? new Map<string, Wave>();
  scope.set(`${kind}:${prefixes.join('|')}`, wave); waves.set(userId, scope);
  const writes = persisting.get(userId) ?? new Set<Promise<void>>(); persisting.set(userId, writes);
  const work = (async () => {
  if (kind === 'access' && prefixes === READ_MODEL_PREFIXES) {
    const entry: CacheEntry = { user_id: userId, key: GLOBAL_ACL_KEY,
      data: `${Date.now()}:${wave.version}:${Math.random().toString(36).slice(2)}`, last_synced_at: new Date().toISOString(), schema_version: 1 };
    // One write regardless of model count; CAS orders competing tab events.
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await localCacheDriver.get(userId, GLOBAL_ACL_KEY);
      if (await localCacheDriver.commitCacheBatch(userId, [entry], [], [{ key: GLOBAL_ACL_KEY, data: previous?.data ?? null }])) return;
    }
    throw new Error('Не удалось сохранить ACL invalidation.');
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const stored = await localCacheDriver.listEntries(userId);
    const byKey = new Map(stored.map((entry) => [entry.key, entry]));
    const targets = stored.filter((entry) => matches(entry.key, prefixes) && !entry.key.startsWith('read:')
      && (confirmed.get(identity(userId, entry.key)) ?? 0) < wave.version);
    const entries: CacheEntry[] = []; const guards: { key: string; data: string | null }[] = [];
    for (const target of targets) {
      const key = freshnessKey(target.key);
      const previous = byKey.get(key);
      // An ordinary data event must not downgrade a pending authoritative ACL
      // check, including one installed by another tab before a reload.
      let access = false;
      let aclToken: string | undefined;
      try { const value = previous && JSON.parse(previous.data); access = value?.kind === 'access'; aclToken = value?.aclToken; } catch { access = !!previous; }
      const marker: Marker = { token: `${Date.now()}:${wave.version}`, kind: access ? 'access' : kind, ...(aclToken ? { aclToken } : {}) };
      const entry: CacheEntry = { user_id: userId, key, data: JSON.stringify(marker), last_synced_at: new Date().toISOString(), schema_version: 1 };
      entries.push(entry); guards.push({ key, data: previous?.data ?? null });
    }
    if (!entries.length || await localCacheDriver.commitCacheBatch(userId, entries, [], guards)) return;
    if (attempt === 2) throw new Error('Не удалось сохранить invalidation.');
  }
  })().finally(() => { writes.delete(work); if (!writes.size && persisting.get(userId) === writes) persisting.delete(userId); });
  writes.add(work); return work;
}

export type ReadScope = { projectId?: string; taskId?: string; userId?: string; view?: 'overview' | 'templates' | 'notifications' };
export async function scopeReadPrefixes(userId: string, scope: ReadScope): Promise<string[]> {
  if (scope.view === 'overview') return ['projects:', `my-tasks:${userId}`];
  if (scope.view === 'templates') return ['templates', 'template:', 'template-items:'];
  if (scope.view === 'notifications') return ['notifications:'];
  if (!scope.projectId && !scope.taskId) return READ_MODEL_PREFIXES;
  const project = scope.projectId;
  const taskIds = scope.taskId ? [scope.taskId] : (await localCacheDriver.listEntries(userId, 'task:'))
    .filter((entry) => { try { return JSON.parse(entry.data).project_id === project; } catch { return false; } }).map((entry) => entry.key.slice(5));
  return [...(project ? [`project:${project}`, `tasks:${project}`, `task-stats:${project}:`, `members:${project}`, `daily-audit:${project}:`] : []),
    ...taskIds.flatMap((task) => [`task:${task}`, `items:${task}:`, `task-role:${task}`, `task-overrides:${task}`, `assignees:${task}`, `last-editors:${task}`, `audit:${task}:`])];
}
export function isAclTable(table: string): boolean { return table === 'project_members' || table === 'task_members'; }
export async function invalidateRealtimeModels(userId: string, table: string, scope: ReadScope, operation = 'UPDATE'): Promise<void> {
  if (isAclTable(table) || (operation === 'DELETE' && (table === 'projects' || table === 'tasks'))) {
    await invalidateReadModels(userId, READ_MODEL_PREFIXES, 'access'); return;
  }
  const keys = await scopeReadPrefixes(userId, scope);
  const prefixes = table === 'notifications' ? ['notifications:']
    : table === 'profiles' ? ['profile:self', 'members:']
    : table === 'task_templates' || table === 'task_template_items' ? ['templates', 'template:', 'template-items:']
    : table === 'task_items' || table === 'audit_log' ? keys.filter((key) => /^(items:|task-stats:|last-editors:|audit:|daily-audit:)/.test(key))
    : table === 'task_assignees' ? [...keys.filter((key) => /^(assignees:|task-stats:)/.test(key)), 'my-tasks:']
    : table === 'tasks' ? [...keys.filter((key) => /^(task:|tasks:|task-stats:)/.test(key)), 'my-tasks:']
    : table === 'projects' ? [...keys.filter((key) => key.startsWith('project:')), 'projects:', 'my-tasks:'] : keys;
  await invalidateReadModels(userId, prefixes);
}
