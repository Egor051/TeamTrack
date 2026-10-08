import { supabase } from '@/lib/supabase/client';
import { subscribeTable, type RealtimeStatus } from '@/lib/supabase/realtime';
import type { Database } from '@/types/database.types';
import { activeCacheUserId, getCached, inheritCachedResult, isCachedResult, isExplicitAccessError, isTransportFailure, readCachedModel } from '@/lib/local-cache/cache';
import { localCacheDriver } from '@/lib/local-cache/driver';
import { usesLocalReads } from '@/lib/connectivity/state';
import { ConnectivityUnavailableError } from '@/lib/connectivity/errors';
import { boundedOperation } from '@/lib/connectivity/deadline';
import { uiRead, UI_READ_TIMEOUT_MS } from '@/lib/supabase/ui-read';
import { cacheAccessDecision, cacheAccessEpoch, confirmCacheAccess, deniedSince, denyCacheAccess } from '@/lib/local-cache/access-state';
import { ResourceAccessDeniedError } from '@/lib/errors/domain-errors';
import { durableReadInvalidation, invalidateReadModels, readAccountEpoch, readInvalidation } from '@/lib/local-cache/read-freshness';
import { subscribeReadModelCommits } from '@/lib/local-cache/read-model-events';
import { createReadRefreshScheduler } from '@/lib/local-cache/refresh-scheduler';

export type Notification = Database['public']['Tables']['notifications']['Row'];

export function stageNotificationText(value: string): string {
  return value
    .replaceAll('Доступ к задаче', 'Доступ к этапу')
    .replaceAll('доступ к задаче', 'доступ к этапу')
    .replaceAll('Вас добавили в задачу', 'Вас добавили в этап')
    .replaceAll('Ваш доступ к задаче был отозван', 'Ваш доступ к этапу был отозван')
    .replaceAll('назначили ответственным за задачу', 'назначили ответственным за этап')
    .replaceAll('назначены исполнителем задачи', 'назначены исполнителем этапа')
    .replaceAll('назначение в задаче', 'назначение на этапе')
    .replaceAll('→ задача «', '→ этап «')
    .replaceAll('в задаче «', 'на этапе «')
    .replaceAll('Задача архивирована', 'Этап архивирован')
    .replaceAll('Задача восстановлена', 'Этап восстановлен')
    .replaceAll('Задача «', 'Этап «');
}

export type NotificationPage = { rows: Notification[]; offline: boolean; hasMore: boolean; limited: boolean };
type NotificationWindow = { rows: Notification[]; read_limit: number };
async function readNotificationWindow(): Promise<NotificationWindow> {
  return readCachedModel('notifications:window', async () => {
    // Match the bootstrap window: all unread + the latest 100 read notices.
    // A paginated route read must never truncate the verified offline model.
    const unread: Notification[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await uiRead(supabase.from('notifications').select('*').eq('is_read', false)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 499));
      if (error) throw error;
      unread.push(...(data ?? [])); if ((data?.length ?? 0) < 500) break;
    }
    const { data, error } = await uiRead(supabase.from('notifications').select('*').eq('is_read', true)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).range(0, 99));
    if (error) throw error;
    return { rows: [...unread, ...(data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)), read_limit: 100 };
  });
}
async function notificationRead<T>(online: () => Promise<T>, cached: (window: NotificationWindow) => T): Promise<T> {
  const userId = await activeCacheUserId();
  const accountEpoch = readAccountEpoch();
  const invalidation = userId ? readInvalidation(userId, 'notifications:window').version : 0;
  const durable = userId ? await durableReadInvalidation(userId, 'notifications:window') : null;
  const baseline = cacheAccessEpoch(); const key = 'cache:notifications:window';
  const local = async (error: unknown): Promise<T> => {
    if (!userId || await activeCacheUserId() !== userId) throw error;
    const window = await getCached<NotificationWindow>(userId, 'notifications:window');
    if (!window || await activeCacheUserId() !== userId || deniedSince(userId, key, baseline)) throw error;
    return cached(window);
  };
  // Do not enter supabase-js's Auth token refresh before choosing offline data.
  if (usesLocalReads()) return local(new ConnectivityUnavailableError());
  try {
    const value = await boundedOperation(online, UI_READ_TIMEOUT_MS);
    const current = userId ? await durableReadInvalidation(userId, 'notifications:window') : null;
    if (readAccountEpoch() !== accountEpoch || (userId && (readInvalidation(userId, 'notifications:window').version !== invalidation
      || current?.global?.data !== durable?.global?.data))) throw new Error('Доступ изменился во время загрузки.');
    if (userId && (await activeCacheUserId() !== userId || !confirmCacheAccess(userId, key, baseline)))
      throw new ResourceAccessDeniedError('Сеанс или доступ изменился во время загрузки.');
    return value;
  } catch (error) {
    if (userId && isExplicitAccessError(error) && await activeCacheUserId() === userId) {
      denyCacheAccess(userId, key);
      try { await localCacheDriver.remove(userId, 'notifications:window'); } catch { /* Volatile denial remains authoritative. */ }
    }
    if (!isTransportFailure(error)) throw error;
    return local(error);
  }
}
export async function fetchNotificationPage(limit = 100, offset = 0): Promise<NotificationPage> {
  if (offset === 0 && limit <= 100) {
    const window = await readNotificationWindow();
    const offline = isCachedResult(window);
    return { rows: inheritCachedResult(window, window.rows.slice(0, limit)), offline, hasMore: offline ? window.rows.length > limit : window.rows.length >= limit, limited: offline };
  }
  return notificationRead<NotificationPage>(async () => {
    const { data, error } = await uiRead(supabase.from('notifications').select('*').order('created_at', { ascending: false }).range(offset, offset + limit - 1));
    if (error) throw error;
    return { rows: data ?? [], offline: false, hasMore: (data?.length ?? 0) === limit, limited: false };
  }, (window) => {
    return { rows: inheritCachedResult(window, window.rows.slice(offset, offset + limit)), offline: true,
      hasMore: offset + limit < window.rows.length, limited: true };
  });
}
export async function fetchNotifications(limit = 100, offset = 0) {
  return (await fetchNotificationPage(limit, offset)).rows;
}
export async function fetchUnreadCount() {
  const userId = await activeCacheUserId();
  const epoch = readAccountEpoch();
  try { return await readCachedModel('notifications:unread-count', async () => {
    const { count, error } = await uiRead(supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('is_read', false));
    if (error) throw error;
    return count ?? 0;
  }); } catch (error) {
    // Older Extended snapshots have a confirmed window but no count model.
    // Derive offline only; badge revalidation always uses HEAD/count.
    if (!(error instanceof ConnectivityUnavailableError) || !usesLocalReads() || !userId) throw error;
    const window = await getCached<NotificationWindow>(userId, 'notifications:window');
    const key = 'notifications:unread-count';
    const pending = await durableReadInvalidation(userId, key);
    if (!window || await activeCacheUserId() !== userId || readAccountEpoch() !== epoch
      || readInvalidation(userId, key).kind === 'access' || pending.kind === 'access'
      || cacheAccessDecision(userId, `cache:${key}`)) throw error;
    return window.rows.filter((n) => !n.is_read).length;
  }
}
export async function markAsRead(id: string) {
  const { error } = await supabase.rpc('mark_notification_read', { p_notification_id: id });
  if (error) throw error;
  const userId = await activeCacheUserId(); if (userId) await invalidateReadModels(userId, ['notifications:']);
}
export async function markAllAsRead() {
  const { error } = await supabase.rpc('mark_all_notifications_read');
  if (error) throw error;
  const userId = await activeCacheUserId(); if (userId) await invalidateReadModels(userId, ['notifications:']);
}
export function subscribeToNotifications(userId: string, onChange: () => void, onStatus?: (status: RealtimeStatus) => void) {
  const refresh = createReadRefreshScheduler(async () => { onChange(); });
  const realtime = subscribeTable('notifications', { userId, onEvent: () => refresh.request(), onStatus });
  const models = subscribeReadModelCommits((commit) => {
    if (commit.userId === userId && commit.keys.some((key) => key === 'notifications:window' || key === 'notifications:unread-count')) refresh.request();
  });
  return () => { realtime(); models(); refresh.dispose(); };
}
