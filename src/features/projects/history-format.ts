type JsonObject = Record<string, unknown>;

export type AuditHistoryRecord = {
  id: number;
  action: string;
  entity_type: string;
  entity_id: string | null;
  user_id: string | null;
  created_at: string;
  old_data: unknown;
  new_data: unknown;
};

export type ChecklistHistoryEntry = {
  id: number;
  taskItemId: string;
  action: string;
  userId: string | null;
  createdAt: string;
  itemTitle: string | null;
  changes: string[];
};

export type DailyProgressSummary = {
  taskItemId: string;
  oldPercentage: number;
  newPercentage: number;
};

const fieldLabels: Record<string, string> = {
  title: 'название',
  description: 'описание',
  position: 'порядок',
  percentage: 'прогресс',
  comment: 'комментарий',
  is_completed: 'состояние',
  is_archived: 'архивный статус',
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function percentageNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function commentValue(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? `«${text}»` : 'нет комментария';
}

function percentageValue(value: unknown): string {
  return typeof value === 'number' || (typeof value === 'string' && value !== '') ? `${value}%` : '—';
}

function textValue(value: unknown, emptyLabel: string): string {
  if (typeof value !== 'string') return value == null ? emptyLabel : String(value);
  const text = value.trim();
  return text ? `«${text}»` : emptyLabel;
}

function positionValue(value: unknown): string {
  return value == null || value === '' ? '—' : String(value);
}

function booleanValue(value: unknown, positive: string, negative: string): string {
  return value === true ? positive : value === false ? negative : '—';
}

function checklistFieldChange(key: string, oldValue: unknown, newValue: unknown): string {
  if (key === 'percentage') return `Прогресс: ${percentageValue(oldValue)} → ${percentageValue(newValue)}`;
  if (key === 'comment') return `Комментарий: ${commentValue(oldValue)} → ${commentValue(newValue)}`;
  if (key === 'description') return `Описание: ${textValue(oldValue, 'нет описания')} → ${textValue(newValue, 'нет описания')}`;
  if (key === 'position') return `Порядок: ${positionValue(oldValue)} → ${positionValue(newValue)}`;
  if (key === 'is_completed') return `Состояние: ${booleanValue(oldValue, 'выполнено', 'не выполнено')} → ${booleanValue(newValue, 'выполнено', 'не выполнено')}`;
  if (key === 'is_archived') return `Архив: ${booleanValue(oldValue, 'в архиве', 'активен')} → ${booleanValue(newValue, 'в архиве', 'активен')}`;
  return `Изменено: ${fieldLabels[key] || key}`;
}

function titleFromSnapshot(oldData: JsonObject, newData: JsonObject): string | null {
  const value = newData.title ?? oldData.title;
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Formats an audit snapshot as user-facing field transitions. */
export function formatAuditChanges(oldData: unknown, newData: unknown): string[] {
  const oldObject = asObject(oldData);
  const newObject = asObject(newData);
  const keys = [...new Set([...Object.keys(oldObject), ...Object.keys(newObject)])];
  const changed = keys.filter((key) => !sameValue(oldObject[key], newObject[key]));
  return changed.map((key) => {
    if (key === 'percentage') return `Прогресс: ${percentageValue(oldObject[key])} → ${percentageValue(newObject[key])}`;
    if (key === 'comment') return `Комментарий: ${commentValue(oldObject[key])} → ${commentValue(newObject[key])}`;
    return `Изменено: ${fieldLabels[key] || key}`;
  });
}

/**
 * Selects the user-facing checklist history from raw task-item audit rows.
 * A title-only update is intentionally excluded, while a title update that
 * also changes another field remains visible with the title omitted.
 */
export function selectChecklistHistory<T extends AuditHistoryRecord>(audit: readonly T[]): ChecklistHistoryEntry[] {
  return audit.flatMap((entry) => {
    if (entry.entity_type !== 'task_item' || !entry.entity_id) return [];

    const oldObject = asObject(entry.old_data);
    const newObject = asObject(entry.new_data);
    const keys = [...new Set([...Object.keys(oldObject), ...Object.keys(newObject)])];
    const meaningfulKeys = keys.filter((key) => key !== 'title' && !sameValue(oldObject[key], newObject[key]));

    let changes: string[];
    if (entry.action === 'created') {
      changes = ['Создан пункт чек-листа'];
    } else if (entry.action === 'removed') {
      changes = ['Пункт чек-листа удалён'];
    } else if (!meaningfulKeys.length && entry.action === 'archived') {
      changes = ['Пункт чек-листа архивирован'];
    } else if (!meaningfulKeys.length && entry.action === 'restored') {
      changes = ['Пункт чек-листа восстановлен'];
    } else if (!meaningfulKeys.length && entry.action === 'checked') {
      changes = ['Состояние: отмечено как выполненное'];
    } else if (!meaningfulKeys.length && entry.action === 'unchecked') {
      changes = ['Состояние: отметка снята'];
    } else if (!meaningfulKeys.length) {
      return [];
    } else {
      changes = meaningfulKeys.map((key) => checklistFieldChange(key, oldObject[key], newObject[key]));
    }

    return [{
      id: entry.id,
      taskItemId: entry.entity_id,
      action: entry.action,
      userId: entry.user_id,
      createdAt: entry.created_at,
      itemTitle: titleFromSnapshot(oldObject, newObject),
      changes,
    }];
  });
}

/**
 * Selects and aggregates actual percentage increases from today's audit rows.
 * The caller is responsible for the date/user scope; this helper only applies
 * the percentage transition rules and preserves the supplied checklist order.
 */
export function selectDailyProgress<T extends AuditHistoryRecord>(
  audit: readonly T[],
  items: readonly { id: string }[],
): DailyProgressSummary[] {
  const byItem = new Map<string, DailyProgressSummary>();
  const orderedAudit = [...audit].sort((left, right) => {
    const timeOrder = left.created_at.localeCompare(right.created_at);
    return timeOrder || left.id - right.id;
  });

  for (const entry of orderedAudit) {
    if (entry.entity_type !== 'task_item' || !entry.entity_id) continue;
    const oldObject = asObject(entry.old_data);
    const newObject = asObject(entry.new_data);
    const oldPercentage = percentageNumber(oldObject.percentage);
    const newPercentage = percentageNumber(newObject.percentage);
    if (oldPercentage === null || newPercentage === null || newPercentage <= oldPercentage) continue;

    const previous = byItem.get(entry.entity_id);
    byItem.set(entry.entity_id, previous
      ? { ...previous, newPercentage }
      : { taskItemId: entry.entity_id, oldPercentage, newPercentage });
  }

  return items.flatMap((item) => {
    const summary = byItem.get(item.id);
    return summary ? [summary] : [];
  });
}

export function formatLastEditorLabel(editor: { display_name: string | null; user_id: string } | null | undefined): string {
  if (!editor) return '';
  return editor.display_name?.trim() || editor.user_id.slice(0, 8);
}
