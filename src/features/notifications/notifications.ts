import { supabase } from '@/lib/supabase/client';
import { subscribeTable, type RealtimeStatus } from '@/lib/supabase/realtime';
import type { Database } from '@/types/database.types';

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

export async function fetchNotifications(limit = 100, offset = 0) {
  const { data, error } = await supabase.from('notifications').select('*').order('created_at', { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw error;
  return data ?? [];
}
export async function fetchUnreadCount() {
  const { count, error } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('is_read', false);
  if (error) throw error;
  return count ?? 0;
}
export async function markAsRead(id: string) {
  const { error } = await supabase.rpc('mark_notification_read', { p_notification_id: id });
  if (error) throw error;
}
export async function markAllAsRead() {
  const { error } = await supabase.rpc('mark_all_notifications_read');
  if (error) throw error;
}
export function subscribeToNotifications(userId: string, onChange: () => void, onStatus?: (status: RealtimeStatus) => void) {
  return subscribeTable('notifications', { userId, onEvent: onChange, onStatus });
}
