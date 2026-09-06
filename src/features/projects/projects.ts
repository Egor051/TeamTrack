import { supabase } from '@/lib/supabase/client';
import { getCurrentUser } from '@/features/auth/auth';
import { ResourceAccessDeniedError } from '@/lib/errors/domain-errors';
import type { Database, Profile, Project, Task, TaskItem } from '@/lib/supabase/client';

export type ProjectRole = Database['public']['Enums']['project_role'];
export type ProjectWithRole = Project & { role: ProjectRole };
export type ProjectMember = { user_id: string; role: ProjectRole; joined_at: string; profile: Profile | null };
export type TaskWithStats = Task & { itemCount: number; completedCount: number; assignees: string[] };
export type MyTask = Task & { project_name: string | null };
export type TaskMember = { user_id: string; approved_at: string; profile: Profile | null };
export type ItemAction = Database['public']['Tables']['item_actions']['Row'];
export type AuditEntry = Database['public']['Tables']['audit_log']['Row'];
export type { Task, TaskItem };

type SupabaseResult<T> = { data: T | null; error: { message: string } | null };

async function requireData<T>(result: SupabaseResult<T>): Promise<NonNullable<T>> {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error('Supabase returned no data');
  return result.data as NonNullable<T>;
}

async function requireSuccess(result: { error: { message: string } | null }): Promise<void> {
  if (result.error) throw new Error(result.error.message);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string, name: string): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new Error(`Invalid ${name}`);
}

async function fetchAll<T>(fetchPage: (from: number, to: number) => PromiseLike<SupabaseResult<T[]>>): Promise<T[]> {
  const pageSize = 500;
  const rows: T[] = [];
  for (let page = 0; ; page += 1) {
    const pageRows = await requireData(await fetchPage(page * pageSize, page * pageSize + pageSize - 1));
    rows.push(...pageRows);
    if (pageRows.length < pageSize) return rows;
  }
}

function chunks<T>(values: T[], size = 100): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

export async function listProjects(includeArchived = false): Promise<ProjectWithRole[]> {
  const projects = await fetchAll<Project>((from, to) => {
    let query = supabase.from('projects').select('*').order('created_at', { ascending: false }).range(from, to);
    query = includeArchived ? query.eq('status', 'archived') : query.eq('status', 'active');
    return query;
  });
  if (!projects.length) return [];
  const memberships = (await Promise.all(chunks(projects.map((p) => p.id)).map(async (ids) => requireData(await supabase.from('project_members').select('project_id, role').in('project_id', ids))))).flat();
  const roles = new Map(memberships.map((m) => [m.project_id, m.role]));
  return projects.flatMap((p) => {
    const role = roles.get(p.id);
    return role ? [{ ...p, role }] : [];
  });
}

export async function getProject(projectId: string): Promise<ProjectWithRole> {
  assertUuid(projectId, 'project id');
  const projectResult = await supabase.from('projects').select('*').eq('id', projectId).maybeSingle();
  if (projectResult.error) throw projectResult.error;
  if (!projectResult.data) throw new ResourceAccessDeniedError('У вас нет доступа к этому проекту.');
  const project = projectResult.data;
  const { data: userData, error: userError } = await getCurrentUser();
  if (userError || !userData.user) throw new Error('Требуется авторизация.');
  const membershipResult = await supabase.from('project_members').select('role').eq('project_id', projectId).eq('user_id', userData.user.id).maybeSingle();
  if (membershipResult.error) throw membershipResult.error;
  if (!membershipResult.data) throw new ResourceAccessDeniedError('У вас нет доступа к этому проекту.');
  return { ...(project as Project), role: membershipResult.data.role as ProjectRole };
}

export async function listProjectTasks(projectId: string): Promise<Task[]> {
  assertUuid(projectId, 'project id');
  return fetchAll<Task>((from, to) => supabase.from('tasks').select('*').eq('project_id', projectId).order('created_at', { ascending: false }).range(from, to));
}

export async function listTasksWithStats(projectId: string, archivedOnly = false): Promise<TaskWithStats[]> {
  const tasks = (await listProjectTasks(projectId)).filter((t) => archivedOnly ? t.status === 'archived' : t.status !== 'archived');
  if (!tasks.length) return [];
  const ids = tasks.map((t) => t.id);
  const items = (await Promise.all(chunks(ids).map((chunk) => fetchAll<{ task_id: string; is_completed: boolean }>((from, to) => supabase.from('task_items').select('task_id,is_completed').in('task_id', chunk).eq('is_archived', false).range(from, to))))).flat();
  const assignees = (await Promise.all(chunks(ids).map((chunk) => fetchAll<{ task_id: string; user_id: string }>((from, to) => supabase.from('task_assignees').select('task_id,user_id').in('task_id', chunk).range(from, to))))).flat();
  const itemStats = new Map<string, { itemCount: number; completedCount: number }>();
  for (const item of items) {
    const stats = itemStats.get(item.task_id) ?? { itemCount: 0, completedCount: 0 };
    stats.itemCount += 1;
    if (item.is_completed) stats.completedCount += 1;
    itemStats.set(item.task_id, stats);
  }
  const assigneeByTask = new Map<string, string[]>();
  for (const assignee of assignees) {
    const list = assigneeByTask.get(assignee.task_id) ?? [];
    list.push(assignee.user_id);
    assigneeByTask.set(assignee.task_id, list);
  }
  return tasks.map((task) => {
    const stats = itemStats.get(task.id) ?? { itemCount: 0, completedCount: 0 };
    return { ...task, ...stats, assignees: assigneeByTask.get(task.id) ?? [] };
  });
}

export async function listMyTasks(userId: string): Promise<MyTask[]> {
  assertUuid(userId, 'user id');
  const assigned = await fetchAll<{ task_id: string }>((from, to) => supabase.from('task_assignees').select('task_id').eq('user_id', userId).range(from, to));
  const ids = assigned.map((row) => row.task_id);
  if (!ids.length) return [];
  const tasks = await fetchAll<Task>((from, to) => supabase.from('tasks').select('*').in('id', ids).neq('status', 'archived').order('updated_at', { ascending: false }).range(from, to));
  const projectIds = [...new Set(tasks.map((task) => task.project_id))];
  const projects = projectIds.length ? await fetchAll<Project>((from, to) => supabase.from('projects').select('*').in('id', projectIds).eq('status', 'active').range(from, to)) : [];
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return tasks.filter((task) => names.has(task.project_id)).map((task) => ({ ...task, project_name: names.get(task.project_id) || null }));
}

export async function createTask(projectId: string, title: string, description?: string) { assertUuid(projectId, 'project id'); return requireData(await supabase.rpc('create_task', { p_project_id: projectId, p_title: title, ...(description ? { p_description: description } : {}) })); }
export async function getTask(taskId: string, projectId?: string) { assertUuid(taskId, 'task id'); if (projectId !== undefined) assertUuid(projectId, 'project id'); let query = supabase.from('tasks').select('*').eq('id', taskId); if (projectId !== undefined) query = query.eq('project_id', projectId); const result = await query.maybeSingle(); if (result.error) throw result.error; if (!result.data) throw new ResourceAccessDeniedError('Нет доступа к задаче.'); return result.data; }
export async function listTaskItems(taskId: string, includeArchived = false): Promise<TaskItem[]> { assertUuid(taskId, 'task id'); return fetchAll<TaskItem>((from, to) => { let query = supabase.from('task_items').select('*').eq('task_id', taskId).order('position').range(from, to); return includeArchived ? query : query.eq('is_archived', false); }); }
export async function updateTaskItem(itemId: string, title: string) { assertUuid(itemId, 'task item id'); return requireSuccess(await supabase.rpc('update_task_item', { p_task_item_id: itemId, p_title: title })); }
export async function archiveTaskItem(itemId: string) { assertUuid(itemId, 'task item id'); return requireSuccess(await supabase.rpc('archive_task_item', { p_task_item_id: itemId })); }
export async function setTaskItemState(itemId: string, completed: boolean) { assertUuid(itemId, 'task item id'); return requireData(await supabase.rpc('set_task_item_state', { p_task_item_id: itemId, p_completed: completed })); }
export async function createTaskItem(taskId: string, title: string, position?: number, description?: string) { assertUuid(taskId, 'task id'); return requireData(await supabase.rpc('create_task_item', { p_task_id: taskId, p_title: title, ...(position !== undefined ? { p_position: position } : {}), ...(description ? { p_description: description } : {}) })); }
export async function listTaskMembers(taskId: string): Promise<TaskMember[]> { assertUuid(taskId, 'task id'); const rows = await fetchAll<{ user_id: string; approved_at: string }>((from, to) => supabase.from('task_members').select('user_id,approved_at').eq('task_id', taskId).range(from, to)); const profiles = rows.length ? (await Promise.all(chunks(rows.map((r) => r.user_id)).map((ids) => fetchAll<Profile>((from, to) => supabase.from('profiles').select('*').in('id', ids).range(from, to))))).flat() : []; const byId = new Map(profiles.map((p) => [p.id, p])); return rows.map((r) => ({ ...r, profile: byId.get(r.user_id) || null })); }
export async function approveTaskMember(taskId: string, userId: string) { assertUuid(taskId, 'task id'); assertUuid(userId, 'user id'); return requireSuccess(await supabase.rpc('approve_task_member', { p_task_id: taskId, p_user_id: userId })); }
export async function revokeTaskMember(taskId: string, userId: string) { assertUuid(taskId, 'task id'); assertUuid(userId, 'user id'); return requireSuccess(await supabase.rpc('revoke_task_member', { p_task_id: taskId, p_user_id: userId })); }
export async function addTaskAssignee(taskId: string, userId: string) { assertUuid(taskId, 'task id'); assertUuid(userId, 'user id'); return requireSuccess(await supabase.rpc('add_task_assignee', { p_task_id: taskId, p_user_id: userId })); }
export async function removeTaskAssignee(taskId: string, userId: string) { assertUuid(taskId, 'task id'); assertUuid(userId, 'user id'); return requireSuccess(await supabase.rpc('remove_task_assignee', { p_task_id: taskId, p_user_id: userId })); }
export async function listTaskAssignees(taskId: string): Promise<string[]> { assertUuid(taskId, 'task id'); const rows = await fetchAll<{ user_id: string }>((from, to) => supabase.from('task_assignees').select('user_id').eq('task_id', taskId).range(from, to)); return rows.map((r) => r.user_id); }
export async function listTaskHistory(taskId: string): Promise<ItemAction[]> { assertUuid(taskId, 'task id'); return fetchAll<ItemAction>((from, to) => supabase.from('item_actions').select('*').eq('task_id', taskId).order('created_at', { ascending: false }).range(from, to)); }
export async function listTaskAudit(projectId: string, taskId: string): Promise<AuditEntry[]> {
  assertUuid(projectId, 'project id'); assertUuid(taskId, 'task id');
  const items = await fetchAll<{ id: string }>((from, to) => supabase.from('task_items').select('id').eq('task_id', taskId).range(from, to));
  const entityIds = [taskId, ...items.map((item) => item.id)];
  const taskResult = await supabase.from('tasks').select('id').eq('id', taskId).eq('project_id', projectId).maybeSingle();
  if (taskResult.error) throw taskResult.error;
  if (!taskResult.data) throw new ResourceAccessDeniedError('Нет доступа к задаче.');
  return (await Promise.all(chunks(entityIds).map((ids) => fetchAll<AuditEntry>((from, to) => supabase.from('audit_log').select('*').eq('project_id', projectId).in('entity_id', ids).order('created_at', { ascending: false }).range(from, to))))).flat().sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  assertUuid(projectId, 'project id');
  const members = await fetchAll<{ user_id: string; role: ProjectRole; joined_at: string }>((from, to) => supabase.from('project_members').select('user_id, role, joined_at').eq('project_id', projectId).order('joined_at').range(from, to));
  if (!members.length) return [];
  const profiles = (await Promise.all(chunks(members.map((m) => m.user_id)).map((ids) => fetchAll<Profile>((from, to) => supabase.from('profiles').select('*').in('id', ids).range(from, to))))).flat();
  const byId = new Map(profiles.map((p) => [p.id, p]));
  return members.map((m) => ({ ...m, profile: byId.get(m.user_id) ?? null }));
}

export async function createProject(name: string, description?: string) {
  return requireData(await supabase.rpc('create_project', { p_name: name, ...(description ? { p_description: description } : {}) }));
}

export async function addProjectMember(projectId: string, userId: string, role: ProjectRole) {
  assertUuid(projectId, 'project id'); assertUuid(userId, 'user id'); return requireSuccess(await supabase.rpc('add_project_member', { p_project_id: projectId, p_user_id: userId, p_role: role }));
}

export async function addProjectMemberByIdentifier(projectId: string, identifier: string, role: ProjectRole) {
  assertUuid(projectId, 'project id');
  if (typeof identifier !== 'string' || !identifier.trim()) throw new Error('Укажите email или ник пользователя.');
  return requireSuccess(await supabase.rpc('add_project_member_by_identifier', { p_project_id: projectId, p_identifier: identifier.trim(), p_role: role }));
}

export async function changeMemberRole(projectId: string, userId: string, role: ProjectRole) {
  assertUuid(projectId, 'project id'); assertUuid(userId, 'user id'); return requireSuccess(await supabase.rpc('change_member_role', { p_project_id: projectId, p_user_id: userId, p_new_role: role }));
}

export async function removeProjectMember(projectId: string, userId: string) {
  assertUuid(projectId, 'project id'); assertUuid(userId, 'user id'); return requireSuccess(await supabase.rpc('remove_project_member', { p_project_id: projectId, p_user_id: userId }));
}

export async function archiveProject(projectId: string) {
  assertUuid(projectId, 'project id'); return requireSuccess(await supabase.rpc('archive_project', { p_project_id: projectId }));
}

export async function restoreProject(projectId: string) {
  assertUuid(projectId, 'project id'); return requireSuccess(await supabase.rpc('restore_project', { p_project_id: projectId }));
}

export async function updateProject(projectId: string, name: string, description: string) {
  assertUuid(projectId, 'project id');
  return requireSuccess(await supabase.rpc('update_project', { p_project_id: projectId, p_name: name, p_description: description }));
}

export async function archiveTask(taskId: string) {
  assertUuid(taskId, 'task id'); return requireSuccess(await supabase.rpc('archive_task', { p_task_id: taskId }));
}

export async function hardDeleteProject(projectId: string) { assertUuid(projectId, 'project id'); return requireSuccess(await supabase.rpc('hard_delete_project', { p_project_id: projectId })); }
export async function hardDeleteTask(taskId: string) { assertUuid(taskId, 'task id'); return requireSuccess(await supabase.rpc('hard_delete_task', { p_task_id: taskId })); }
export async function hardDeleteTaskItem(itemId: string) { assertUuid(itemId, 'task item id'); return requireSuccess(await supabase.rpc('hard_delete_task_item', { p_task_item_id: itemId })); }

export async function restoreTask(taskId: string) {
  assertUuid(taskId, 'task id'); return requireSuccess(await supabase.rpc('restore_task', { p_task_id: taskId }));
}
