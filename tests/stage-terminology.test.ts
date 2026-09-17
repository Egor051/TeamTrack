import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/client', () => ({ supabase: {} }));

import { stageNotificationText } from '../src/features/notifications/notifications';

describe('stage terminology', () => {
  it('converts known project task notification phrases', () => {
    expect(stageNotificationText('Доступ к задаче предоставлен')).toBe('Доступ к этапу предоставлен');
    expect(stageNotificationText('Вы назначены исполнителем задачи «Релиз» в проекте «Сайт».'))
      .toBe('Вы назначены исполнителем этапа «Релиз» в проекте «Сайт».');
    expect(stageNotificationText('«Проверить сборку» → задача «Релиз» → проект «Сайт».'))
      .toBe('«Проверить сборку» → этап «Релиз» → проект «Сайт».');
  });

  it('leaves unrelated task wording unchanged', () => {
    expect(stageNotificationText('Фоновая задача импорта завершена')).toBe('Фоновая задача импорта завершена');
  });
});
