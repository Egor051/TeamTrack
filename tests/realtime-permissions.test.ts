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
  it('multiplexes permission invalidations over one private user topic', () => {
    const subscriptions: Array<{ on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> }> = [];
    channel.mockImplementation(() => {
      const subscription = {
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnThis(),
      };
      subscriptions.push(subscription);
      return subscription;
    });

    const onChange = vi.fn();
    const cleanup = subscribeToPermissionChanges('00000000-0000-4000-8000-000000000001', onChange);
    expect(channel).toHaveBeenCalledOnce();
    expect(channel).toHaveBeenCalledWith(
      'user:00000000-0000-4000-8000-000000000001',
      { config: { private: true } },
    );
    expect(subscriptions[0].on).toHaveBeenCalledOnce();
    expect(subscriptions[0].on.mock.calls[0].slice(0, 2)).toEqual(['broadcast', { event: 'invalidate' }]);

    const receive = subscriptions[0].on.mock.calls[0][2];
    receive({ payload: { table: 'task_members', operation: 'UPDATE' } });
    receive({ payload: { table: 'projects', operation: 'UPDATE' } });
    expect(onChange).toHaveBeenCalledTimes(2);

    cleanup();
    expect(removeChannel).toHaveBeenCalledOnce();
  });
});
