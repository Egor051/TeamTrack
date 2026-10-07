import type { Profile, TaskItem } from '@/lib/supabase/client';
import type { ProjectWithRole, ProjectMember, Task, TaskTemplate, TaskTemplateItem, AuditEntry, TaskItemLastEditor } from '@/features/projects/projects';
import type { Notification } from '@/features/notifications/notifications';
import type { AccountManifest, Dataset } from './bootstrap-types';
import type { CacheEntry } from './types';
import { LOCAL_CACHE_SCHEMA_VERSION } from './types';
import { taskAuditEntityIds } from '@/features/projects/task-audit';

export type AccountRows = Partial<Record<Dataset, unknown[]>>;
export function cacheEntry(userId: string, key: string, data: unknown): CacheEntry {
  return { user_id: userId, key, data: JSON.stringify(data), last_synced_at: new Date().toISOString(), schema_version: LOCAL_CACHE_SCHEMA_VERSION };
}
function groupBy<T>(values: T[], key: (value: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) { const id = key(value); if (id !== null) { const group = groups.get(id) ?? []; group.push(value); groups.set(id, group); } }
  return groups;
}
export function accountReadModels(userId: string, rows: AccountRows, manifest: AccountManifest, previous: CacheEntry[]): CacheEntry[] {
  const result: CacheEntry[] = [];
  const put = (key: string, value: unknown) => result.push(cacheEntry(userId, key, value));
  const projects = (rows.projects ?? []) as ProjectWithRole[];
  const tasks = (rows.tasks ?? []) as Task[];
  const profiles = new Map(((rows.profiles ?? []) as Profile[]).map((p) => [p.id, p]));
  const roleMap = new Map(((rows.roles ?? []) as { task_id: string; role: string }[]).map((r) => [r.task_id, r.role]));
  const members = (rows.members ?? []) as (Omit<ProjectMember, 'profile'> & { project_id: string })[];
  const assignees = (rows.assignees ?? []) as { task_id: string; user_id: string }[];
  // A concurrent item pull/reconciliation may have advanced confirmed versions
  // after a batch was downloaded. Never roll those versions backwards.
  const latestItems = new Map<string, TaskItem>();
  for (const entry of previous.filter((e) => /^items:.*:(active|archived|all)$/.test(e.key))) {
    for (const item of JSON.parse(entry.data) as TaskItem[]) {
      if (!latestItems.has(item.id) || (item.sync_version ?? 0) > (latestItems.get(item.id)!.sync_version ?? 0)) latestItems.set(item.id, item);
    }
  }
  const items = ((rows.items ?? []) as TaskItem[]).map((item) => {
    const latest = latestItems.get(item.id);
    return latest && (latest.sync_version ?? 0) > (item.sync_version ?? 0) ? latest : item;
  });
  const projectMap = new Map(projects.map((p) => [p.id, p]));
  const tasksByProject = groupBy(tasks, (t) => t.project_id);
  const membersByProject = groupBy(members, (m) => m.project_id);
  const assigneesByTask = groupBy(assignees, (a) => a.task_id);
  const itemsByTask = groupBy(items, (i) => i.task_id);
  const dailyByProject = groupBy((rows.daily_audit ?? []) as AuditEntry[], (a) => a.project_id);
  const overridesByTask = groupBy((rows.overrides ?? []) as { task_id: string }[], (r) => r.task_id);
  const editorsByTask = groupBy((rows.last_editors ?? []) as (TaskItemLastEditor & { task_id: string })[], (r) => r.task_id);
  const historyByEntity = groupBy((rows.history ?? []) as AuditEntry[], (a) => a.entity_id);
  const templateItems = groupBy((rows.template_items ?? []) as TaskTemplateItem[], (i) => i.template_id);
  if (rows.profile?.length !== 1) throw new Error('Не сохранён профиль пользователя.');
  put('profile:self', rows.profile[0]);
  for (const status of ['active', 'archived'] as const) put(`projects:${status}`, projects.filter((p) => p.status === status));
  for (const project of projects) {
    put(`project:${project.id}`, project);
    put(`blocked:${project.id}`, false);
    put(`members:${project.id}`, (membersByProject.get(project.id) ?? []).map((m) => ({ ...m, profile: profiles.get(m.user_id) ?? null })));
    const projectTasks = (tasksByProject.get(project.id) ?? []).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    put(`tasks:${project.id}`, projectTasks);
    for (const mode of ['active', 'archived'] as const) {
      const stats = projectTasks.filter((t) => (t.status === 'archived') === (mode === 'archived')).map((task) => {
        const active = (itemsByTask.get(task.id) ?? []).filter((i) => !i.is_archived);
        return { ...task, itemCount: active.length, completedCount: active.filter((i) => i.is_completed).length,
          progressPercent: active.length ? active.reduce((sum, i) => sum + i.percentage, 0) / active.length : 0,
          assignees: (assigneesByTask.get(task.id) ?? []).map((a) => a.user_id) };
      });
      put(`task-stats:${project.id}:${mode}`, stats);
    }
    put(`daily-audit:${project.id}:${manifest.day_start}`, dailyByProject.get(project.id) ?? []);
  }
  for (const task of tasks) {
    if (!roleMap.has(task.id)) throw new Error('Не сохранены права доступа к этапу.');
    put(`task:${task.id}`, task);
    put(`blocked-task:${task.id}`, false);
    put(`task-role:${task.id}`, roleMap.get(task.id));
    put(`assignees:${task.id}`, (assigneesByTask.get(task.id) ?? []).map((a) => a.user_id));
    const all = (itemsByTask.get(task.id) ?? []).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    put(`items:${task.id}:active`, all.filter((i) => !i.is_archived));
    put(`items:${task.id}:archived`, all.filter((i) => i.is_archived));
    const project = projectMap.get(task.project_id);
    if (project?.role === 'owner' || project?.role === 'admin') put(`task-overrides:${task.id}`, overridesByTask.get(task.id) ?? []);
    if (rows.last_editors) put(`last-editors:${task.id}`, editorsByTask.get(task.id) ?? []);
    if (rows.history) {
      const ids = taskAuditEntityIds(task.id, all.map((i) => i.id), (rows.history as AuditEntry[]).filter((a) => a.project_id === task.project_id));
      const history = ids.flatMap((id) => historyByEntity.get(id) ?? []).filter((a) => a.project_id === task.project_id);
      put(`audit:${task.id}:90days`, history.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id));
    }
  }
  const projectIds = new Set(projects.map((p) => p.id));
  const taskIds = new Set(tasks.map((t) => t.id));
  for (const entry of previous) {
    if (entry.key.startsWith('project:') && !projectIds.has(entry.key.slice(8))) put(`blocked:${entry.key.slice(8)}`, true);
    if (entry.key.startsWith('task:') && !taskIds.has(entry.key.slice(5))) put(`blocked-task:${entry.key.slice(5)}`, true);
  }
  const activeProjects = new Map(projects.filter((p) => p.status === 'active').map((p) => [p.id, p.name]));
  const mine = new Set(assignees.filter((a) => a.user_id === userId).map((a) => a.task_id));
  put(`my-tasks:${userId}`, tasks.filter((t) => mine.has(t.id) && t.status !== 'archived' && activeProjects.has(t.project_id))
    .map((t) => ({ ...t, project_name: activeProjects.get(t.project_id) })));
  put('templates', rows.templates as TaskTemplate[]);
  for (const template of rows.templates as TaskTemplate[]) {
    const content = (templateItems.get(template.id) ?? []).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));
    put(`template-items:${template.id}`, content);
    put(`template:${template.id}`, { ...template, items: content });
  }
  if (rows.notifications) put('notifications:window', { rows: (rows.notifications as Notification[])
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)), read_limit: 100 });
  return result;
}
