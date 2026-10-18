import type { Profile, TaskItem } from '@/lib/supabase/client';
import type { ProjectWithRole, ProjectMember, Task, TaskTemplate, TaskTemplateItem, AuditEntry, TaskItemLastEditor, TaskProjectContext, TaskParticipant } from '@/features/projects/projects';
import type { Notification } from '@/features/notifications/notifications';
import type { AccountManifest, Dataset } from './bootstrap-types';
import type { CacheEntry } from './types';
import { cacheSchemaVersion } from './types';
import { taskAuditEntityIds } from '@/features/projects/task-audit';
import { progressStatus } from '@/features/projects/deadlines';

export type AccountRows = Partial<Record<Dataset, unknown[]>>;
export function cacheEntry(userId: string, key: string, data: unknown): CacheEntry {
  return { user_id: userId, key, data: JSON.stringify(data), last_synced_at: new Date().toISOString(), schema_version: cacheSchemaVersion(key) };
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
  const roleRows = (rows.roles ?? []) as { task_id: string; role: string; project_context?: TaskProjectContext; participants?: TaskParticipant[] }[];
  const roleMap = new Map(roleRows.map((r) => [r.task_id, r.role]));
  const contextMap = new Map(roleRows.filter((r) => r.project_context).map((r) => [r.task_id, r.project_context!]));
  const participantMap = new Map(roleRows.filter((r) => r.participants).map((r) => [r.task_id, r.participants!]));
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
    put(`members:${project.id}`, (membersByProject.get(project.id) ?? []).map(({ project_id: _projectId, ...m }) => ({ ...m, profile: profiles.get(m.user_id) ?? null })));
    const projectTasks = (tasksByProject.get(project.id) ?? []).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    put(`tasks:${project.id}`, projectTasks);
    for (const mode of ['active', 'archived'] as const) {
      const stats = projectTasks.filter((t) => (t.status === 'archived') === (mode === 'archived')).map((task) => {
        const active = (itemsByTask.get(task.id) ?? []).filter((i) => !i.is_archived);
        return { ...task, status: progressStatus(active.length ? active.reduce((sum, i) => sum + i.percentage, 0) / active.length : 0, task.status === 'archived'), itemCount: active.length, completedCount: active.filter((i) => i.percentage === 100).length,
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
    const context = contextMap.get(task.id) ?? (project ? { id: project.id, name: project.name, status: project.status, role: project.role } : null);
    if (context) put(`task-context:${task.id}`, context);
    if (!project && context) put(`daily-audit:${task.project_id}:${manifest.day_start}`, dailyByProject.get(task.project_id) ?? []);
    const participantRows = participantMap.get(task.id) ?? (membersByProject.get(task.project_id) ?? []).map((member) => ({
      user_id: member.user_id, display_name: profiles.get(member.user_id)?.display_name ?? member.user_id.slice(0, 8), project_role: member.role,
      direct_role: ((overridesByTask.get(task.id) ?? []) as { user_id?: string; role_override?: string }[]).find((row) => row.user_id === member.user_id)?.role_override ?? null,
      effective_role: member.role, is_direct: false, set_at: null,
    }));
    put(`task-participants:${task.id}`, participantRows);
    if (project?.role === 'owner' || project?.role === 'admin') put(`task-overrides:${task.id}`, (overridesByTask.get(task.id) ?? []).map(({ task_id: _taskId, ...row }) => row));
    if (rows.last_editors) put(`last-editors:${task.id}`, (editorsByTask.get(task.id) ?? []).map(({ task_id: _taskId, ...row }) => row));
    if (rows.history) {
      const ids = taskAuditEntityIds(task.id, all.map((i) => i.id), (rows.history as AuditEntry[]).filter((a) => a.project_id === task.project_id));
      const taskMembership = (rows.history as AuditEntry[]).filter((entry) => ['task_member', 'task_assignee'].includes(entry.entity_type)
        && [entry.old_data, entry.new_data].some((data) => data && typeof data === 'object' && !Array.isArray(data) && data.task_id === task.id));
      const history = [...ids.flatMap((id) => historyByEntity.get(id) ?? []), ...taskMembership].filter((a) => a.project_id === task.project_id && Date.parse(a.created_at) >= Date.now() - 90 * 86400000);
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
  for (const context of contextMap.values()) if (context.status === 'active') activeProjects.set(context.id, context.name);
  const activeTasks = new Map(tasks.filter((t) => t.status !== 'archived' && activeProjects.has(t.project_id)).map((t) => [t.id, t]));
  put('checklist-overview', items.filter((i) => !i.is_archived && activeTasks.has(i.task_id)).map((i) => ({
    id: i.id, task_id: i.task_id, project_id: activeTasks.get(i.task_id)!.project_id,
    percentage: i.percentage, is_completed: i.percentage === 100, comment: i.comment,
    deadline_at: i.deadline_at ?? null, sync_version: i.sync_version,
  })));
  const mine = new Set(assignees.filter((a) => a.user_id === userId).map((a) => a.task_id));
  for (const [taskId, people] of participantMap) if (people.some((person) => person.user_id === userId && person.is_direct)) mine.add(taskId);
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
