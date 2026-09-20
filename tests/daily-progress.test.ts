import { describe, expect, it, vi } from 'vitest';
const { supabase } = vi.hoisted(() => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('@/lib/supabase/client', () => ({ supabase }));
vi.mock('@/features/auth/auth', () => ({ getCurrentUser: vi.fn() }));
import { getUtcPlus3DayStart } from '@/features/projects/projects';
import { selectDailyProgress, type AuditHistoryRecord } from '@/features/projects/history-format';

const item = (id: string) => ({ id });
const audit = (id: number, taskItemId: string, createdAt: string, oldPercentage: unknown, newPercentage: unknown, action = 'updated'): AuditHistoryRecord => ({
  id,
  action,
  entity_type: 'task_item',
  entity_id: taskItemId,
  user_id: 'user-1',
  created_at: createdAt,
  old_data: { percentage: oldPercentage },
  new_data: { percentage: newPercentage },
});

describe('daily checklist progress selection', () => {
  it('uses the final state instead of the maximum intermediate value', () => {
    const result = selectDailyProgress([
      audit(3, 'second', '2026-09-18T10:00:00.000Z', 10, 30),
      audit(1, 'first', '2026-09-18T09:00:00.000Z', 0, 20),
      audit(4, 'second', '2026-09-18T11:00:00.000Z', 30, 20),
    ], [{ ...item('first'), percentage: 20 }, { ...item('second'), percentage: 20 }]);

    expect(result).toEqual([
      { taskItemId: 'first', oldPercentage: 0, newPercentage: 20 },
      { taskItemId: 'second', oldPercentage: 10, newPercentage: 20 },
    ]);
  });

  it.each([
    [[0, 100, 50], 0, 50],
    [[10, 30, 20], 10, 20],
    [[30, 20], null, null],
    [[30, 70, 40], 30, 40],
    [[50, 100, 80], 50, 80],
    [[20, 40, 60], 20, 60],
    [[0, 20, 10, 30], 0, 30],
  ])('calculates %j from start-of-day to final state', (values, oldPercentage, newPercentage) => {
    const transitions = (values as number[]).slice(1).map((value, index) =>
      audit(index + 1, 'item', `2026-09-18T${String(index + 9).padStart(2, '0')}:00:00.000Z`, (values as number[])[index], value),
    );
    const result = selectDailyProgress(transitions, [{ ...item('item'), percentage: (values as number[]).at(-1) }]);
    expect(result).toEqual(oldPercentage === null ? [] : [{ taskItemId: 'item', oldPercentage, newPercentage }]);
  });

  it('includes completion and excludes non-percentage changes', () => {
    const result = selectDailyProgress([
      audit(1, 'complete', '2026-09-18T09:00:00.000Z', 50, 100, 'checked'),
      audit(2, 'decreased', '2026-09-18T10:00:00.000Z', 100, 80),
      audit(3, 'reset', '2026-09-18T10:30:00.000Z', 100, 0, 'unchecked'),
      { ...audit(4, 'comment', '2026-09-18T11:00:00.000Z', undefined, undefined), old_data: { comment: null }, new_data: { comment: 'note' } },
    ], [
      { ...item('complete'), percentage: 100 },
      { ...item('decreased'), percentage: 80 },
      { ...item('reset'), percentage: 0 },
      { ...item('comment'), percentage: 0 },
    ]);

    expect(result).toEqual([{ taskItemId: 'complete', oldPercentage: 50, newPercentage: 100 }]);
  });
});

describe('UTC+3 day boundary', () => {
  it('does not depend on the device timezone', () => {
    expect(getUtcPlus3DayStart(new Date('2026-09-18T00:30:00.000Z'))).toBe('2026-09-17T21:00:00.000Z');
    expect(getUtcPlus3DayStart(new Date('2026-09-18T21:30:00.000Z'))).toBe('2026-09-18T21:00:00.000Z');
  });
});
