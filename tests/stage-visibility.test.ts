import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('project stage visibility', () => {
  it('loads every project stage without a client task-members filter', () => {
    const dataLayer = readFileSync(resolve(root, 'src/features/projects/projects.ts'), 'utf8');
    const listStart = dataLayer.indexOf('export async function listProjectTasks');
    const listEnd = dataLayer.indexOf('\n}\n', listStart);
    const listSource = dataLayer.slice(listStart, listEnd < 0 ? undefined : listEnd);

    expect(listSource).toContain("supabase.from('tasks').select('*').eq('project_id', projectId)");
    expect(listSource).not.toContain('task_members');
  });

  it('scopes only the tasks SELECT policy to project membership', () => {
    const migration = readFileSync(
      resolve(root, 'supabase/migrations/20260918000917_project_member_task_visibility.sql'),
      'utf8',
    );

    expect(migration).toContain('create policy tasks_select_project_member');
    expect(migration).toContain('using (private.is_project_member(project_id))');
    expect(migration).not.toContain('create or replace function private.has_task_access');
    expect(migration).not.toContain('task_items_select');
    expect(migration).not.toContain('task_assignees_select');
  });
});
