import { localCacheDriver } from './driver';
import type { CacheEntry } from './types';

export const READ_FRESHNESS_MS = 60_000;
export const READ_MODEL_PREFIXES = ['projects:', 'project:', 'tasks:', 'task:', 'task-stats:', 'my-tasks:', 'items:',
  'members:', 'assignees:', 'task-role:', 'task-overrides:', 'last-editors:', 'audit:', 'daily-audit:',
  'templates', 'template:', 'template-items:', 'notifications:', 'profile:self'];
export type InvalidationKind = 'data' | 'refresh' | 'access';
type Wave = { version: number; prefixes: string[]; kind: InvalidationKind };
type Marker = { token: string; kind: InvalidationKind };
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
  for (const wave of waves.get(userId)?.values() ?? []) {
    if (!matches(key, wave.prefixes)) continue;
    latest = Math.max(latest, wave.version);
    if (wave.version <= (confirmed.get(identity(userId, key)) ?? 0)) continue;
    if (kind !== 'access') kind = wave.kind === 'access' ? 'access' : kind === 'refresh' ? 'refresh' : wave.kind;
  }
  return { version: latest, kind };
}
export function confirmReadFreshness(userId: string, key: string, baseline: number): void {
  confirmed.set(identity(userId, key), Math.max(confirmed.get(identity(userId, key)) ?? 0, baseline));
}
export async function durableReadInvalidation(userId: string, key: string): Promise<{ entry: CacheEntry | null; kind: InvalidationKind | null }> {
  const entry = await localCacheDriver.get(userId, freshnessKey(key));
  if (!entry) return { entry: null, kind: null };
  try {
    const value = JSON.parse(entry.data) as Marker;
    return { entry, kind: ['data', 'refresh', 'access'].includes(value.kind) ? value.kind : 'access' };
  } catch { return { entry, kind: 'access' }; }
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
      try { access = !!previous && JSON.parse(previous.data).kind === 'access'; } catch { access = !!previous; }
      const marker: Marker = { token: `${Date.now()}:${wave.version}`, kind: access ? 'access' : kind };
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
