import { activeCacheUserId } from './cache';
import { localCacheDriver } from './driver';
import { applyPendingOperations } from './outbox';
import type { OfflineOperation, ReconciledItem, SyncConflict } from './types';
import { validSyncVersion } from './pull-cache';

const listeners = new Set<(userId: string) => void>();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    channel = new BroadcastChannel('tasktrace-conflicts');
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as { type?: string; user_id?: string } | null;
      if (message?.type === 'conflicts-changed' && typeof message.user_id === 'string')
        for (const listener of listeners) listener(message.user_id);
    };
  }
  return channel;
}

export function subscribeConflictChanges(listener: (userId: string) => void): () => void {
  listeners.add(listener);
  getChannel();
  return () => { listeners.delete(listener); };
}

export function announceConflictChange(userId: string): void {
  for (const listener of listeners) listener(userId);
  getChannel()?.postMessage({ type: 'conflicts-changed', user_id: userId });
}

export async function unresolvedConflicts(userId: string): Promise<SyncConflict[]> {
  if (!userId || await activeCacheUserId() !== userId) return [];
  const rows = await localCacheDriver.listConflicts(userId);
  if (await activeCacheUserId() !== userId) return [];
  return rows.filter((row) => row.user_id === userId && row.status === 'unresolved');
}

function cachedName(data: string | undefined, field: string): string {
  if (!data) return '';
  try { return String((JSON.parse(data) as Record<string, unknown>)[field] ?? ''); }
  catch { return ''; }
}

export async function recordConflict(input: {
  userId: string;
  operations: OfflineOperation[];
  serverState: ReconciledItem | null;
  serverVersion: number | null;
  conflictId?: string;
}): Promise<SyncConflict> {
  if (await activeCacheUserId() !== input.userId) throw new Error('Сеанс изменился.');
  const chain = [...input.operations].sort((a, b) => a.sequence - b.sequence);
  const first = chain[0];
  if (!first || chain.some((row) => row.user_id !== input.userId || row.task_item_id !== first.task_item_id))
    throw new Error('Invalid conflict chain');
  const entries = await localCacheDriver.listEntries(input.userId);
  const byKey = new Map(entries.map((entry) => [entry.key, entry.data]));
  const cachedItems = byKey.get(`items:${first.task_id}:active`) ?? byKey.get(`items:${first.task_id}:all`);
  const cachedItem = cachedItems ? (JSON.parse(cachedItems) as ReconciledItem[]).find((row) => row.id === first.task_item_id) : undefined;
  const baseline: ReconciledItem = input.serverState ?? cachedItem ??
    { id: first.task_item_id, percentage: 0, is_completed: false, comment: null };
  const local = applyPendingOperations([baseline], chain, input.userId, first.task_id)[0];
  const fields: SyncConflict['conflicting_fields'] = [];
  if (chain.some((row) => row.type !== 'set_task_item_comment')) fields.push('progress');
  if (chain.some((row) => row.type === 'set_task_item_comment')) fields.push('comment');
  const now = new Date().toISOString();
  const conflict: SyncConflict = {
    conflict_id: input.conflictId ?? `${input.userId}:${first.task_item_id}`,
    user_id: input.userId, project_id: first.project_id, task_id: first.task_id, task_item_id: first.task_item_id,
    operation_ids: chain.map((row) => row.operation_id), local_effective_state: local,
    server_state: input.serverState, server_version: validSyncVersion(input.serverVersion) ? input.serverVersion : null,
    conflicting_fields: fields, project_name: cachedName(byKey.get(`project:${first.project_id}`), 'name'),
    task_name: cachedName(byKey.get(`task:${first.task_id}`), 'title'),
    item_name: input.serverState?.title ?? cachedItem?.title ?? first.task_item_id,
    created_at: now, updated_at: now, status: 'unresolved',
  };
  await localCacheDriver.createConflict(conflict);
  announceConflictChange(input.userId);
  return conflict;
}

export async function chooseServer(userId: string, conflictId: string): Promise<void> {
  if (await activeCacheUserId() !== userId) throw new Error('Сеанс изменился.');
  await localCacheDriver.resolveServerConflict(userId, conflictId);
  announceConflictChange(userId);
}
