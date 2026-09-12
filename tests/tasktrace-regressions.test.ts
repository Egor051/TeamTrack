import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterChecklistItems } from '@/features/projects/checklist';
import { formatAuditChanges, formatLastEditorLabel, selectChecklistHistory } from '@/features/projects/history-format';

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

describe('user-facing checklist history selector', () => {
  const entry = (id: number, old_data: unknown, new_data: unknown, action = 'updated') => ({
    id,
    action,
    entity_type: 'task_item',
    entity_id: '00000000-0000-4000-8000-000000000001',
    user_id: '00000000-0000-4000-8000-000000000002',
    created_at: `2026-09-12T10:0${id}:00.000Z`,
    old_data,
    new_data,
  });

  it('selects percentage transitions from audit data, including checkbox-driven values', () => {
    const result = selectChecklistHistory([
      entry(1, { percentage: 0 }, { percentage: 12 }),
      entry(2, { percentage: 12 }, { percentage: 50 }),
      entry(3, { percentage: 50 }, { percentage: 100 }),
      entry(4, { percentage: 100 }, { percentage: 50 }),
      entry(5, { is_completed: false }, { is_completed: true }, 'checked'),
    ]);
    const changes = result.flatMap((item) => item.changes);
    expect(changes).toContain('Прогресс: 0% → 12%');
    expect(changes).toContain('Прогресс: 12% → 50%');
    expect(changes).toContain('Прогресс: 50% → 100%');
    expect(changes).toContain('Прогресс: 100% → 50%');
    expect(changes).toContain('Состояние: не выполнено → выполнено');
  });

  it('keeps all supported checklist fields in the checklist section', () => {
    const result = selectChecklistHistory([
      entry(1, { comment: null }, { comment: 'текст' }),
      entry(2, { comment: 'текст' }, { comment: null }),
      entry(3, { comment: 'A' }, { comment: 'B' }),
      entry(4, { description: 'старое' }, { description: 'новое' }),
      entry(5, { position: 1 }, { position: 2 }, 'reordered'),
      entry(6, { is_archived: false }, { is_archived: true }, 'archived'),
    ]);
    const changes = result.flatMap((item) => item.changes);
    expect(changes).toContain('Комментарий: нет комментария → «текст»');
    expect(changes).toContain('Комментарий: «текст» → нет комментария');
    expect(changes).toContain('Комментарий: «A» → «B»');
    expect(changes).toContain('Описание: «старое» → «новое»');
    expect(changes).toContain('Порядок: 1 → 2');
    expect(changes).toContain('Архив: активен → в архиве');
  });

  it('excludes title-only changes but keeps title plus another field', () => {
    const result = selectChecklistHistory([
      entry(1, { title: 'Пункт 1' }, { title: 'Пункт 2' }),
      entry(2, { title: 'Пункт 1', percentage: 20 }, { title: 'Пункт 2', percentage: 50 }),
      entry(3, { title: 'Пункт 1', comment: null }, { title: 'Пункт 2', comment: 'текст' }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].changes).toEqual(['Прогресс: 20% → 50%']);
    expect(result[1].changes).toEqual(['Комментарий: нет комментария → «текст»']);
    expect(result.every((item) => item.changes.every((change) => !change.includes('название')))).toBe(true);
  });

  it('keeps checklist creation visible even when title is the only snapshot field', () => {
    const result = selectChecklistHistory([entry(1, null, { title: 'Новый пункт' }, 'created')]);
    expect(result).toHaveLength(1);
    expect(result[0].changes).toEqual(['Создан пункт чек-листа']);
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

  it('keeps task actions side-by-side with responsive wrapping and separates summary surfaces', () => {
    const project = readFileSync(resolve(root, 'src/app/(app)/projects/[id].tsx'), 'utf8');
    const task = readFileSync(resolve(root, 'src/app/(app)/projects/[id]/tasks/[taskId].tsx'), 'utf8');
    const progress = readFileSync(resolve(root, 'src/components/ui/progress.tsx'), 'utf8');
    expect(task).toContain('>Редактировать</Button>');
    expect(task).not.toContain('>Редактировать задачу</Button>');
    expect(task).toContain('actions: { flexDirection: "row", flexWrap: "wrap"');
    expect(task).toContain('<Card muted>');
    expect(project).toContain('<Card muted>');
    expect(project).toContain('taskHead: { flexDirection: "row"');
    expect(project).toContain('flexWrap: "wrap"');
    expect(progress).toContain('label: { flex: 1, minWidth: 0 }');
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
