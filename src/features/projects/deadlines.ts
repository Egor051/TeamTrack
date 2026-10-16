export const DEADLINE_WARNING_MS = 12 * 60 * 60 * 1000;
export type DeadlineState = 'normal' | 'urgent' | 'overdue';
export type DeadlineItem = { deadline_at?: string | null; percentage: number; is_archived?: boolean };
export type ChecklistOverviewItem = DeadlineItem & {
  id: string; task_id: string; project_id: string; is_completed: boolean; comment: string | null; sync_version?: number;
};

export function deadlineState(item: DeadlineItem, now = Date.now()): DeadlineState {
  if (!item.deadline_at || item.is_archived || item.percentage === 100) return 'normal';
  const due = Date.parse(item.deadline_at);
  if (!Number.isFinite(due)) return 'normal';
  if (now >= due) return 'overdue';
  return due - now <= DEADLINE_WARNING_MS ? 'urgent' : 'normal';
}

export function deadlineSummary(items: readonly DeadlineItem[], now = Date.now()) {
  let urgent = 0; let overdue = 0;
  for (const item of items) {
    const state = deadlineState(item, now);
    if (state === 'urgent') urgent++;
    if (state === 'overdue') overdue++;
  }
  return { urgent, overdue, state: overdue ? 'overdue' : urgent ? 'urgent' : 'normal' } as const;
}

export function groupChecklistOverview(items: readonly ChecklistOverviewItem[]) {
  const tasks = new Map<string, ChecklistOverviewItem[]>();
  const projects = new Map<string, ChecklistOverviewItem[]>();
  for (const item of items) {
    const task = tasks.get(item.task_id) ?? []; task.push(item); tasks.set(item.task_id, task);
    const project = projects.get(item.project_id) ?? []; project.push(item); projects.set(item.project_id, project);
  }
  return { tasks, projects };
}

export function progressStatus(percent: number, archived = false): 'not_started' | 'in_progress' | 'completed' | 'archived' {
  return archived ? 'archived' : percent === 100 ? 'completed' : percent > 0 ? 'in_progress' : 'not_started';
}

export function averageChecklistProgress(items: readonly { percentage: number }[]): number {
  return items.length ? items.reduce((sum, item) => sum + item.percentage, 0) / items.length : 0;
}

export function formatDeadline(value: string): string {
  return new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
}

export function isFutureDeadline(value: string | number, now = Date.now()): boolean {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now;
}

/** Next local visual boundary; it never schedules a server notification. */
export function nextDeadlineBoundary(items: readonly DeadlineItem[], now: number): number | null {
  let next = Infinity;
  for (const item of items) {
    if (!item.deadline_at || item.is_archived || item.percentage === 100) continue;
    const due = Date.parse(item.deadline_at);
    if (due - DEADLINE_WARNING_MS > now) next = Math.min(next, due - DEADLINE_WARNING_MS);
    else if (due > now) next = Math.min(next, due);
  }
  return Number.isFinite(next) ? next : null;
}

/** Reject DST gaps rather than silently moving the chosen wall-clock time. */
export function localDeadline(year: number, month: number, day: number, hour: number, minute: number): Date | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const date = new Date(year, month, day, hour, minute, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
    && date.getHours() === hour && date.getMinutes() === minute ? date : null;
}

/** A repeated wall-clock time can denote two instants during the autumn fold. */
export function localDeadlineCandidates(year: number, month: number, day: number, hour: number, minute: number): Date[] {
  const first = localDeadline(year, month, day, hour, minute);
  if (!first) return [];
  const later = new Date(first.getTime() + 3 * 3_600_000);
  const shift = later.getTimezoneOffset() - first.getTimezoneOffset();
  if (shift <= 0 || shift > 180) return [first];
  const second = new Date(first.getTime() + shift * 60_000);
  return second.getFullYear() === year && second.getMonth() === month && second.getDate() === day
    && second.getHours() === first.getHours() && second.getMinutes() === minute ? [first, second] : [first];
}

export function formatUtcOffset(minutesWest: number): string {
  const minutes = Math.abs(minutesWest);
  return `UTC${minutesWest <= 0 ? '+' : '−'}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
