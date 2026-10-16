import type { Notification } from './notifications';

export type NotificationFilters = { projectId?: string; taskId?: string; from?: string; to?: string; action?: string; read?: 'all' | 'unread' | 'read' };
export function notificationEvent(item: Notification): string {
  const data = item.data as Record<string, unknown> | null;
  return typeof data?.deadline_event === 'string' ? `deadline:${data.deadline_event}` : item.type;
}
export function notificationTone(item: Notification): 'neutral' | 'warning' | 'danger' {
  const event = notificationEvent(item);
  return ['deadline:overdue', 'deadline:reopened_overdue'].includes(event) ? 'danger'
    : ['deadline:urgent', 'deadline:reopened_urgent'].includes(event) ? 'warning' : 'neutral';
}
export function matchesNotification(item: Notification, filters: NotificationFilters): boolean {
  return (!filters.projectId || item.project_id === filters.projectId) && (!filters.taskId || item.task_id === filters.taskId)
    && (!filters.from || Date.parse(item.created_at) >= Date.parse(filters.from)) && (!filters.to || Date.parse(item.created_at) <= Date.parse(filters.to))
    && (!filters.action || (filters.action.startsWith('deadline:') ? notificationEvent(item) === filters.action : item.type === filters.action))
    && (!filters.read || filters.read === 'all' || item.is_read === (filters.read === 'read'));
}

// Read is monotonic for a notification ID. Keep acknowledgements through late
// page/cache/Realtime responses; discard pending changes only on RPC failure.
export class NotificationReadState {
  private changes = new Map<string, { original: Notification; at: string; confirmed: boolean }>();
  begin(rows: Notification[]): string[] {
    const ids: string[] = [];
    for (const row of rows) if (!row.is_read && !this.changes.has(row.id)) {
      ids.push(row.id); this.changes.set(row.id, { original: row, at: new Date().toISOString(), confirmed: false });
    }
    return ids;
  }
  confirm(ids: string[]) { for (const id of ids) { const change = this.changes.get(id); if (change) change.confirmed = true; } }
  accept(rows: Notification[]): Notification[] {
    for (const row of rows) if (row.is_read) this.confirm([row.id]);
    return this.apply(rows);
  }
  rollback(ids: string[], rows: Notification[]): Notification[] {
    const restored = new Map<string, Notification>();
    for (const id of ids) { const change = this.changes.get(id); if (change && !change.confirmed) { restored.set(id, change.original); this.changes.delete(id); } }
    const existing = new Set(rows.map((row) => row.id));
    return [...rows.map((row) => restored.has(row.id) ? { ...row, is_read: restored.get(row.id)!.is_read, read_at: restored.get(row.id)!.read_at } : row),
      ...[...restored.values()].filter((row) => !existing.has(row.id))].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  }
  apply(rows: Notification[]): Notification[] {
    return rows.map((row) => { const change = this.changes.get(row.id); return change ? { ...row, is_read: true, read_at: row.read_at ?? change.at } : row; });
  }
}

export const notificationActions = [
  ['task_member_added', 'Добавление участника'], ['task_member_removed', 'Удаление участника'], ['task_assigned', 'Назначение исполнителя'], ['task_unassigned', 'Снятие исполнителя'],
  ['task_item_changed', 'Изменение чек-листа'], ['task_item_checked', 'Выполнение пункта'], ['task_item_unchecked', 'Возобновление пункта'],
  ['project_archived', 'Архивация проекта'], ['project_restored', 'Восстановление проекта'], ['task_archived', 'Архивация этапа'], ['task_restored', 'Восстановление этапа'], ['task_role_changed', 'Изменение роли'],
  ['deadline:set', 'Дедлайн установлен'], ['deadline:changed', 'Дедлайн изменён'], ['deadline:removed', 'Дедлайн удалён'], ['deadline:completed', 'Дедлайн выполнен'],
  ['deadline:urgent', 'Приближается дедлайн'], ['deadline:overdue', 'Просрочен дедлайн'], ['deadline:reopened_urgent', 'Снова приближается дедлайн'], ['deadline:reopened_overdue', 'Снова просрочен дедлайн'],
].map(([value, label]) => ({ value, label }));
