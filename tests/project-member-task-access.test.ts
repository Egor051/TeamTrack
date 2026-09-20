import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('inherited project-member stage access', () => {
  it('makes project membership the effective task access check', () => {
    const migration = readFileSync(
      resolve(root, 'supabase/migrations/20260925000000_inherit_project_member_task_access.sql'),
      'utf8',
    );

    expect(migration).toContain('join public.project_members pm');
    expect(migration).not.toContain('join public.task_members tm');
    expect(migration).toContain('task_members is not required');
    expect(migration).toContain('create or replace function public.add_task_assignee');
    expect(migration).not.toContain('assignee must have access to the task (task_members)');
  });

  it('derives checklist capabilities from the loaded project/task, not task_members', () => {
    const task = readFileSync(
      resolve(root, 'src/app/(app)/projects/[id]/tasks/[taskId].tsx'),
      'utf8',
    );

    expect(task).toContain('const hasTaskAccess = Boolean(user && project && task);');
    expect(task).not.toContain('taskMembers.some');
    expect(task).toContain('Доступ участника проекта');
    expect(task).not.toContain('нужен отдельный доступ к этапу');
  });
});
