import { describe, expect, it, vi } from 'vitest';

const { channel, removeChannel } = vi.hoisted(() => {
  const channel = vi.fn();
  const removeChannel = vi.fn();
  return { channel, removeChannel };
});

vi.mock('@/lib/supabase/client', () => ({
  supabase: { channel, removeChannel },
}));

import { subscribeToPermissionChanges } from '@/lib/supabase/realtime';

describe('permission realtime invalidation', () => {
  it('subscribes to every permission source through one abstraction', () => {
    const subscriptions: Array<{ on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> }> = [];
    channel.mockImplementation((name: string) => {
      const subscription = {
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnThis(),
      };
      subscriptions.push(subscription);
      expect(name).toMatch(/^tasktrace:/);
      return subscription;
    });

    const cleanup = subscribeToPermissionChanges('00000000-0000-4000-8000-000000000001', vi.fn());
    expect(channel).toHaveBeenCalledTimes(5);
    expect(channel.mock.calls.map(([name]) => String(name).split(':')[1])).toEqual([
      'project_members', 'task_members', 'task_assignees', 'projects', 'tasks',
    ]);
    expect(subscriptions.every((entry) => entry.on.mock.calls.length === 3)).toBe(true);
    cleanup();
    expect(removeChannel).toHaveBeenCalledTimes(5);
  });
});
