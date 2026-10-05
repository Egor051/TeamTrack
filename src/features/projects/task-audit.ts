import type { Database } from '@/types/database.types';
type AuditEntry = Database['public']['Tables']['audit_log']['Row'];
export function taskAuditEntityIds(taskId: string, currentItemIds: string[], rows: AuditEntry[]): string[] {
  const ids = new Set([taskId, ...currentItemIds]);
  // The removal event is an immutable link after the structural row is gone.
  // Include earlier events of that entity, even when they predate task_id data.
  for (const row of rows) {
    if (row.entity_type !== 'task_item' || !row.entity_id) continue;
    for (const data of [row.old_data, row.new_data]) if (data && typeof data === 'object' && !Array.isArray(data) && data.task_id === taskId) ids.add(row.entity_id);
  }
  return [...ids];
}
