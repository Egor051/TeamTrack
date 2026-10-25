import { useCallback, useSyncExternalStore } from 'react';
import { getSyncState, subscribeSyncState, type SyncState } from './status';
import { subscribeConflictChanges } from './conflicts';
import { listPendingOperations } from './outbox';
import type { OfflineOperation } from './types';
import { subscribeReadModelCommits } from './read-model-events';
import { localCacheDriver } from './driver';
import type { PendingMutation } from '@/lib/supabase/mutation';

type Snapshot = { snapshot: SyncState | null; failed: OfflineOperation | null; review: OfflineOperation | null;
  onlineReview: { key: string; mutation: PendingMutation } | null; readError: boolean };
const empty: Snapshot = { snapshot: null, failed: null, review: null, onlineReview: null, readError: false };
type Entry = { value: Snapshot; listeners: Set<() => void>; stop: () => void };
const entries = new Map<string, Entry>();

/** All sync widgets for an account share one subscription and one local read. */
function subscribe(userId: string, listener: () => void) {
  let entry = entries.get(userId);
  if (!entry) {
    let active = true; let generation = 0; let queued = false;
    const created: Entry = { value: empty, listeners: new Set(), stop: () => undefined };
    entry = created; entries.set(userId, created);
    const publish = (value: Snapshot) => {
      if (JSON.stringify(created.value) === JSON.stringify(value)) return;
      created.value = value; created.listeners.forEach((changed) => changed());
    };
    const refresh = () => {
      // Runtime and queue events can arrive together in the same transaction.
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false; if (!active) return;
        const request = ++generation;
        void Promise.all([getSyncState(userId), listPendingOperations(userId), localCacheDriver.listEntries(userId, 'sync:mutation:')]).then(([snapshot, operations, mutations]) => {
          const online = mutations.map(entry => ({ key: entry.key, mutation: JSON.parse(entry.data) as PendingMutation })).find(row => row.mutation.phase === 'review' || row.mutation.phase === 'unknown') ?? null;
          if (active && request === generation) publish({ snapshot, failed: operations.find((row) => row.status === 'failed') ?? null,
            review: operations.find(row => row.status === 'review') ?? null, onlineReview: online, readError: false });
        }).catch(() => { if (active && request === generation) publish({ ...created.value, readError: true }); });
      });
    };
    const changed = (id: string) => { if (id === userId) refresh(); };
    const offSync = subscribeSyncState(changed); const offConflicts = subscribeConflictChanges(changed);
    const offRead = subscribeReadModelCommits(event => { if (event.keys.includes('sync:mutation:review')) changed(event.userId); });
    created.stop = () => { active = false; generation++; offSync(); offConflicts(); offRead(); };
    refresh();
  }
  entry.listeners.add(listener);
  const current = entry;
  return () => {
    current.listeners.delete(listener);
    if (!current.listeners.size) { current.stop(); if (entries.get(userId) === current) entries.delete(userId); }
  };
}

export function useSyncIndicator(userId: string | null): Snapshot {
  const listen = useCallback((listener: () => void) => userId ? subscribe(userId, listener) : () => undefined, [userId]);
  const read = useCallback(() => userId ? entries.get(userId)?.value ?? empty : empty, [userId]);
  return useSyncExternalStore(listen, read, () => empty);
}
