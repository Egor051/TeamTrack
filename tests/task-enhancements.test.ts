import { describe, expect, it, vi } from 'vitest';
const { supabase } = vi.hoisted(() => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('@/lib/supabase/client', () => ({ supabase }));
vi.mock('@/features/auth/auth', () => ({ getCurrentUser: vi.fn() }));
import { calculateAverageProgress, setTaskItemPercentage } from '@/features/projects/projects';

describe('percentage progress model', () => {
  it.each([
    [[100, 100, 50, 0], 62.5],
    [[20, 20, 20], 20],
    [[], 0],
  ])('calculates the arithmetic mean for %s', (values, expected) => {
    expect(calculateAverageProgress(values as number[])).toBe(expected);
  });
});

describe('percentage input validation', () => {
  it('rejects values outside 0..100 before the RPC call', async () => {
    await expect(setTaskItemPercentage('00000000-0000-4000-8000-000000000001', -1)).rejects.toThrow('целым числом от 0 до 100');
    await expect(setTaskItemPercentage('00000000-0000-4000-8000-000000000001', 101)).rejects.toThrow('целым числом от 0 до 100');
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});
