import type { ChecklistOverviewItem } from '@/features/projects/deadlines';
import type { PullChange } from './types';

/** Shared by the IndexedDB, SQLite and memory transactions. */
export function patchChecklistOverview(rows: ChecklistOverviewItem[], change: PullChange, projectId?: string): ChecklistOverviewItem[] {
  const current = rows.find((row) => row.id === change.task_item_id);
  const item = change.item;
  if (item && current?.sync_version && item.sync_version && current.sync_version > item.sync_version) return rows;
  const rest = rows.filter((row) => row.id !== change.task_item_id);
  if (change.change_type === 'delete' || !item || item.is_archived) return rest;
  const project = current?.project_id ?? projectId;
  if (!project) return rows;
  return [...rest, { id: item.id, task_id: change.task_id, project_id: project,
    percentage: item.percentage, is_completed: item.percentage === 100, comment: item.comment,
    deadline_at: item.deadline_at !== undefined ? item.deadline_at : current?.deadline_at ?? null, sync_version: item.sync_version }]
    .sort((a, b) => a.id.localeCompare(b.id));
}
