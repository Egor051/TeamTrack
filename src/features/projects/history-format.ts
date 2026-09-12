type JsonObject = Record<string, unknown>;

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

export function formatLastEditorLabel(editor: { display_name: string | null; user_id: string } | null | undefined): string {
  if (!editor) return '';
  return editor.display_name?.trim() || editor.user_id.slice(0, 8);
}
