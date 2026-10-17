import { supabase } from '@/lib/supabase/client';
import { uiRead } from '@/lib/supabase/ui-read';
import { activeCacheUserId, filterBlockedTasks, inheritCachedResult, isTaskProjectBlocked, readCachedModel } from '@/lib/local-cache/cache';
import { applyPendingOperations, listPendingOperations } from '@/lib/local-cache/outbox';
import type { ChecklistOverviewItem } from './deadlines';
import { readAccountEpoch } from '@/lib/local-cache/read-freshness';
import { ResourceAccessDeniedError } from '@/lib/errors/domain-errors';

export const CHECKLIST_OVERVIEW_KEY = 'checklist-overview';
export async function filterChecklistOverview(userId: string, rows: ChecklistOverviewItem[]) {
  const tasks = new Set((await filterBlockedTasks(userId, [...new Set(rows.map((i) => i.task_id))].map((id) => ({ id })))).map((i) => i.id));
  const subjects = new Map(rows.map((row) => [row.task_id, row.project_id]));
  const allowed = new Set((await Promise.all([...subjects].map(async ([taskId, projectId]) =>
    await isTaskProjectBlocked(userId, taskId, projectId) ? null : taskId))).filter((id): id is string => !!id));
  return rows.filter((i) => tasks.has(i.task_id) && allowed.has(i.task_id));
}

export async function overlayChecklistOverview(userId: string, rows: ChecklistOverviewItem[]) {
  const pending = await listPendingOperations(userId);
  if (!pending.length) return rows;
  const byTask = new Map<string, ChecklistOverviewItem[]>();
  for (const row of rows) { const group = byTask.get(row.task_id) ?? []; group.push(row); byTask.set(row.task_id, group); }
  return [...byTask].flatMap(([task, items]) => applyPendingOperations(items, pending, userId, task));
}

export async function listChecklistOverview(): Promise<ChecklistOverviewItem[]> {
  const userId = await activeCacheUserId();
  const accountEpoch = readAccountEpoch();
  const rows = await readCachedModel(CHECKLIST_OVERVIEW_KEY, async () => {
    const result: ChecklistOverviewItem[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await uiRead(supabase.from('checklist_overview').select('*').order('id').range(offset, offset + 499));
      if (error) throw error;
      result.push(...data as ChecklistOverviewItem[]);
      if (data.length < 500) return result;
    }
  }, { filterCached: filterChecklistOverview });
  const effective = userId ? await overlayChecklistOverview(userId, rows) : rows;
  if (await activeCacheUserId() !== userId || readAccountEpoch() !== accountEpoch) throw new ResourceAccessDeniedError('Сеанс изменился во время загрузки.');
  return inheritCachedResult(rows, effective);
}
