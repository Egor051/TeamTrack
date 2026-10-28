import { localCacheDriver } from '@/lib/local-cache/driver';
import { currentReadAccount } from '@/lib/local-cache/read-freshness';
import { getConnectivityState } from '@/lib/connectivity/state';
import { getNetworkFacts } from '@/lib/local-cache/runtime-state';
import { boundedOperation } from '@/lib/connectivity/deadline';
import { supabaseEnv } from '@/lib/env';
import { errorContext, type ErrorContext } from '@/lib/errors/operation-error';
import { reportClientError, subscribeClientErrors } from '@/lib/errors/error-events';
import { createErrorEvent, eventFingerprint, type DiagnosticState } from './event';
import { DiagnosticQueue, DIAGNOSTIC_KEY } from './queue';
import { knownServiceWorkerVersion, readServiceWorkerVersion } from './service-worker';

let current: { userId: string; queue: DiagnosticQueue } | null = null;
async function stateForError(userId: string, context: ErrorContext): Promise<DiagnosticState> {
  const state: DiagnosticState = { connection: getConnectivityState(), network_issue: getNetworkFacts().issue, capabilities: null, cache: null, outbox: null, sw_version: knownServiceWorkerVersion() };
  if (!context.taskId || !context.itemId) return state;
  await boundedOperation(async signal => {
    const driver = localCacheDriver.withOperation?.(signal) ?? localCacheDriver;
    await Promise.all([
      driver.get(userId, `items:${context.taskId}:active`).then(entry => {
        if (!entry) { state.cache = { snapshot: 'missing', version: null }; return; }
        try {
          const rows: unknown = JSON.parse(entry.data);
          if (!Array.isArray(rows)) throw new Error();
          const row = rows.find(r => r?.id === context.itemId);
          const version = Number.isSafeInteger(row?.sync_version) && row.sync_version >= 1 ? row.sync_version as number : null;
          state.cache = { snapshot: !row ? 'missing' : version && entry.schema_version === 1 ? 'valid' : 'invalid', version };
        } catch { state.cache = { snapshot: 'invalid', version: null }; }
      }).catch(() => { state.cache = { snapshot: 'unavailable', version: null }; }),
      driver.listPending(userId, context.taskId).then(rows => {
        const own = rows.filter(r => r.task_item_id === context.itemId);
        const count = (status: string) => Math.min(100000, own.filter(r => r.status === status).length);
        state.outbox = { pending: count('pending'), failed: count('failed'), conflict: count('conflict'), review: count('review'),
          acknowledged: count('synced_unreconciled'), dependent: own.some(r => !!r.depends_on_operation_id) };
      }).catch(() => undefined),
    ]);
  }, 1000).catch(() => undefined);
  return state;
}

export function startClientDiagnostics(userId: string): () => void {
  if (process.env.EXPO_PUBLIC_CLIENT_DIAGNOSTICS_ENABLED !== 'true') return () => undefined;
  let stopped = false;
  const active = () => !stopped && currentReadAccount() === userId;
  const queue = new DiagnosticQueue({
    now: Date.now, active,
    // Edge delivery is independent of the shared Data API reachability state.
    canSend: () => getNetworkFacts().physical !== 'disconnected' && !(typeof navigator !== 'undefined' && navigator.onLine === false),
    read: () => boundedOperation(async signal => (await (localCacheDriver.withOperation?.(signal) ?? localCacheDriver).get(userId, DIAGNOSTIC_KEY))?.data ?? null, 1000),
    write: (data, expected) => boundedOperation(signal => (localCacheDriver.withOperation?.(signal) ?? localCacheDriver).commitCacheBatch(userId,
      [{ user_id: userId, key: DIAGNOSTIC_KEY, data, schema_version: 1, last_synced_at: new Date().toISOString() }], [], [{ key: DIAGNOSTIC_KEY, data: expected }], signal), 1000),
    send: async (event, signal) => {
      const { readPersistedSession } = await import('@/lib/supabase/client');
      const session = await boundedOperation(() => readPersistedSession(), 1000, signal);
      if (!active() || session?.user.id !== userId || !session.expires_at || session.expires_at * 1000 <= Date.now()) return 'wait';
      const env = supabaseEnv();
      // Plain fetch intentionally bypasses connectivity classification, SDK
      // retries, user mutation receipts and the business outbox.
      const response = await fetch(`${env.url}/functions/v1/client-errors`, { method: 'POST', signal,
        headers: { apikey: env.anonKey, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) });
      if (response.ok) return 'accepted';
      if (response.status === 429) return response.headers.get('X-Client-Error-Limit') === 'day' ? 'quota' : 'retry';
      if ([400, 401, 403, 404, 413].includes(response.status)) return 'discard';
      return 'retry';
    },
  });
  current?.queue.stop(); current = { userId, queue };
  const seen = new WeakSet<object>();
  const fingerprints = new Map<string, number>();
  const unsubscribe = subscribeClientErrors((error, supplied) => {
    if (!active()) return;
    if (error && typeof error === 'object') { if (seen.has(error)) return; seen.add(error); }
    const context = { ...supplied, ...errorContext(error) };
    if (context.userId && context.userId !== userId) return;
    const now = Date.now();
    for (const [key, time] of fingerprints) if (now - time >= 15 * 60_000) fingerprints.delete(key);
    const fingerprint = eventFingerprint(createErrorEvent(error, context, { connection: getConnectivityState(), network_issue: getNetworkFacts().issue, capabilities: null, cache: null, outbox: null, sw_version: knownServiceWorkerVersion() }, now));
    if (fingerprints.has(fingerprint) || fingerprints.size >= 20) return;
    fingerprints.set(fingerprint, now); // Limit metadata reads as well as HTTP.
    // Capture is detached from the operation, bounded, allowlisted and fenced.
    void stateForError(userId, context).then(state => {
      if (active()) return queue.capture(createErrorEvent(error, context, state, now));
    }).catch(() => undefined);
  });
  const onError = (event: ErrorEvent) => reportClientError(event.error ?? new Error(), { stage: 'unhandled' });
  const onRejection = (event: PromiseRejectionEvent) => reportClientError(event.reason, { stage: 'unhandled' });
  if (typeof window !== 'undefined') { window.addEventListener('error', onError); window.addEventListener('unhandledrejection', onRejection); }
  void readServiceWorkerVersion().catch(() => undefined);
  void queue.flush();
  return () => {
    stopped = true; unsubscribe(); queue.stop();
    if (current?.queue === queue) current = null;
    if (typeof window !== 'undefined') { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); }
  };
}
export function flushClientDiagnostics(userId: string): void {
  if (current?.userId === userId) void current.queue.flush();
}
