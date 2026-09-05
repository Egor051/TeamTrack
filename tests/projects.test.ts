import { describe, expect, it, vi } from 'vitest';

const { supabase } = vi.hoisted(() => ({ supabase: { from: vi.fn() } }));
vi.mock('@/lib/supabase/client', () => ({ supabase }));
vi.mock('@/features/auth/auth', () => ({ getCurrentUser: vi.fn() }));

import { getTask } from '@/features/projects/projects';
import { ResourceAccessDeniedError } from '@/lib/errors/domain-errors';
import { userMessage } from '@/lib/errors/user-message';

const taskId = '00000000-0000-4000-8000-000000000001';
const projectId = '00000000-0000-4000-8000-000000000002';

function taskQuery(result: { data: unknown; error: { message: string } | null }) {
  const query = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue(result) };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  supabase.from.mockReturnValue(query);
}

describe('getTask authorization outcome', () => {
  it('turns an RLS-hidden task into the domain access error without single() coercion', async () => {
    taskQuery({ data: null, error: null });
    const error = await getTask(taskId, projectId).catch((value: unknown) => value);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(error).toBeInstanceOf(ResourceAccessDeniedError);
    expect(userMessage(error, 'Не удалось загрузить данные')).toBe('Нет доступа к задаче.');
    expect(consoleError).not.toHaveBeenCalled();
    expect(supabase.from).toHaveBeenCalledWith('tasks');
    consoleError.mockRestore();
  });

  it('keeps genuine Supabase errors as unexpected errors', async () => {
    taskQuery({ data: null, error: { message: 'network request failed' } });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(getTask(taskId)).rejects.toMatchObject({ message: 'network request failed' });
    userMessage(new Error('network request failed'), 'fallback');
    expect(consoleError).toHaveBeenCalledWith('[TaskTrace]', expect.any(Error));
    consoleError.mockRestore();
  });
});
