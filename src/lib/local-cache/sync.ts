import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase/client';
import type { Database } from '@/lib/supabase/client';
import { supabaseEnv } from '@/lib/env';
import { activeCacheUserId, isTransportFailure } from './cache';
import { localCacheDriver } from './driver';
import { listPendingOperations, offlineSyncEnabled } from './outbox';
import type { OfflineOperation, ReconciledItem } from './types';

const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<(userId: string) => void>();

export function subscribeSyncChanges(listener: (userId: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function announce(userId: string): void {
  for (const listener of listeners) listener(userId);
}

async function sameUser(userId: string): Promise<boolean> {
  return await activeCacheUserId() === userId;
}

async function clientFor(userId: string): Promise<SupabaseClient<Database> | null> {
  const { data, error } = await supabase.auth.getSession();
  const session = data.session;
  if (error || !session || session.user.id !== userId ||
    (session.expires_at && session.expires_at * 1000 <= Date.now())) return null;
  const { url, anonKey } = supabaseEnv();
  // Pin this request to the inspected user's token. The shared app client may
  // switch accounts before its fetch attaches Authorization.
  return createClient<Database>(url, anonKey, {
    accessToken: async () => session.access_token,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function send(client: SupabaseClient<Database>, operation: OfflineOperation): Promise<boolean | number | string | null> {
  if (operation.type === 'set_task_item_state') {
    const { data, error } = await client.rpc('apply_task_item_state_operation', {
      p_operation_id: operation.operation_id, p_task_item_id: operation.task_item_id,
      p_completed: (operation.payload as { completed: boolean }).completed,
    });
    if (error) throw error;
    if (data === null) throw new Error('Server returned no state result');
    return data;
  }
  if (operation.type === 'set_task_item_percentage') {
    const { data, error } = await client.rpc('apply_task_item_percentage_operation', {
      p_operation_id: operation.operation_id, p_task_item_id: operation.task_item_id,
      p_percentage: (operation.payload as { percentage: number }).percentage,
    });
    if (error) throw error;
    if (data === null) throw new Error('Server returned no percentage result');
    return data;
  }
  const { data, error } = await client.rpc('apply_task_item_comment_operation', {
    p_operation_id: operation.operation_id, p_task_item_id: operation.task_item_id,
    p_comment: (operation.payload as { comment: string | null }).comment ?? '',
  });
  if (error) throw error;
  return data;
}

function deterministicRejection(error: unknown): boolean {
  const value = error as { code?: string; status?: number; message?: string } | null;
  if (isTransportFailure(error)) return false;
  if (/jwt|token|session|authentication/i.test(value?.message ?? '')) return false;
  return ['42501', '22023', '23514', 'P0001', '22P02'].includes(value?.code ?? '');
}

async function reconcile(operation: OfflineOperation): Promise<void> {
  if (!await sameUser(operation.user_id)) throw new Error('Session changed');
  const client = await clientFor(operation.user_id);
  if (!client) throw new Error('Session unavailable');
  const activeSnapshot: ReconciledItem[] = [];
  for (let from = 0; ; from += 500) {
    if (!await sameUser(operation.user_id)) throw new Error('Session changed');
    const { data, error } = await client.from('task_items').select('*')
      .eq('task_id', operation.task_id).eq('is_archived', false)
      .order('position').order('id').range(from, from + 499);
    if (error) throw error;
    activeSnapshot.push(...(data ?? []));
    if (!data || data.length < 500) break;
  }
  const item = activeSnapshot.find((row) => row.id === operation.task_item_id);
  if (!item) throw new Error('Confirmed task item is unavailable');
  if (!await sameUser(operation.user_id)) throw new Error('Session changed');
  await localCacheDriver.reconcileOperation(operation.user_id, operation.operation_id, item, activeSnapshot);
  announce(operation.user_id);
}

async function run(userId: string): Promise<void> {
  if (!offlineSyncEnabled() || !await sameUser(userId)) return;
  while (offlineSyncEnabled() && await sameUser(userId)) {
    const operations = await listPendingOperations(userId);
    const oldest = operations[0];
    if (!oldest || oldest.status === 'failed') return;
    if (oldest.status === 'synced_unreconciled') {
      try { await reconcile(oldest); } catch { return; }
      continue;
    }

    let acknowledged = false;
    for (let attempt = 0; attempt < 3 && await sameUser(userId); attempt += 1) {
      const client = await clientFor(userId);
      if (!client) return;
      let result: boolean | number | string | null;
      try {
        result = await send(client, oldest);
      } catch (error) {
        if (!await sameUser(userId)) return;
        if (deterministicRejection(error)) {
          await localCacheDriver.markOperation(userId, oldest.operation_id, 'failed', undefined,
            (error as { message?: string }).message ?? 'Server rejected operation');
          announce(userId);
          return;
        }
        if (!isTransportFailure(error) || attempt === 2) return;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
        continue;
      }
      if (!await sameUser(userId)) return;
      await localCacheDriver.markOperation(userId, oldest.operation_id, 'synced_unreconciled', result);
      acknowledged = true;
      announce(userId);
      break;
    }
    if (!acknowledged) return;
    try { await reconcile(oldest); } catch { return; }
  }
}

export function syncPendingOperations(userId: string): Promise<void> {
  if (!offlineSyncEnabled()) return Promise.resolve();
  const existing = inFlight.get(userId);
  if (existing) return existing;
  const task = run(userId).finally(() => { inFlight.delete(userId); });
  inFlight.set(userId, task);
  return task;
}
