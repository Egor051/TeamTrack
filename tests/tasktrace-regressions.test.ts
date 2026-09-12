import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterChecklistItems } from '@/features/projects/checklist';
import { formatAuditChanges, formatLastEditorLabel } from '@/features/projects/history-format';

const root = resolve(import.meta.dirname, '..');

describe('checklist active/archive regression', () => {
  const items = [
    { id: 'active', is_archived: false },
    { id: 'archived', is_archived: true },
  ];

  it('changes the visible list when the archive filter toggles', () => {
    expect(filterChecklistItems(items, false).map((item) => item.id)).toEqual(['active']);
    expect(filterChecklistItems(items, true).map((item) => item.id)).toEqual(['archived']);
  });
});

describe('history value formatting regression', () => {
  it('renders percentage transitions explicitly', () => {
    expect(formatAuditChanges({ percentage: 20 }, { percentage: 50 })).toContain('Прогресс: 20% → 50%');
    expect(formatAuditChanges({ percentage: 0 }, { percentage: 25 })).toContain('Прогресс: 0% → 25%');
    expect(formatAuditChanges({ percentage: 25 }, { percentage: 100 })).toContain('Прогресс: 25% → 100%');
    expect(formatAuditChanges({ percentage: 100 }, { percentage: 50 })).toContain('Прогресс: 100% → 50%');
  });

  it('renders comment transitions including null/empty states', () => {
    expect(formatAuditChanges({ comment: null }, { comment: 'новый комментарий' })).toContain('Комментарий: нет комментария → «новый комментарий»');
    expect(formatAuditChanges({ comment: 'старый' }, { comment: '' })).toContain('Комментарий: «старый» → нет комментария');
  });

  it('keeps the empty editor line empty and uses a stable id only for a real editor', () => {
    expect(formatLastEditorLabel(undefined)).toBe('');
    expect(formatLastEditorLabel({ display_name: null, user_id: '12345678-abcd-4000-8000-000000000001' })).toBe('12345678');
  });
});

describe('UI architecture regressions', () => {
  it('keeps the action log collapsed initially and renders nested confirmation in the parent host', () => {
    const history = readFileSync(resolve(root, 'src/app/(app)/projects/[id]/tasks/[taskId]/history.tsx'), 'utf8');
    const confirm = readFileSync(resolve(root, 'src/components/ui/confirm-dialog.tsx'), 'utf8');
    const task = readFileSync(resolve(root, 'src/app/(app)/projects/[id]/tasks/[taskId].tsx'), 'utf8');
    const dataLayer = readFileSync(resolve(root, 'src/features/projects/projects.ts'), 'utf8');
    expect(history).toContain('useState(false)');
    expect(history).toContain('actionLogExpanded');
    expect(confirm).toContain('nestedRoot');
    expect(task).toContain('nested');
    expect(task).toContain('showArchivedItems ? "archived" : "active"');
    expect(dataLayer).toContain("mode === 'archived'");
    expect(dataLayer).toContain("query.eq('is_archived', true)");
  });

  it('does not use a fake last-editor label and keeps SQL empty state nullable', () => {
    const task = readFileSync(resolve(root, 'src/app/(app)/projects/[id]/tasks/[taskId].tsx'), 'utf8');
    const migration = readFileSync(resolve(root, 'supabase/migrations/20260920000000_last_editor_empty_state.sql'), 'utf8');
    expect(task).not.toContain('|| "Пользователь"');
    expect(migration).toContain('nullif(p.display_name, \'\') as display_name');
    expect(migration).not.toContain("coalesce(nullif(p.display_name, ''), 'Пользователь')");
  });

  it('keeps realtime as an invalidation signal and revalidates through RLS queries', () => {
    const provider = readFileSync(resolve(root, 'src/features/auth/PermissionProvider.tsx'), 'utf8');
    const realtime = readFileSync(resolve(root, 'src/lib/supabase/realtime.ts'), 'utf8');
    expect(provider).toContain("supabase.from('project_members')");
    expect(provider).toContain("supabase.from('task_members')");
    expect(provider).not.toContain('event.new');
    expect(realtime).toContain('only tells the client');
  });
});
