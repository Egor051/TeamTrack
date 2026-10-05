import { beforeEach, describe, expect, it, vi } from 'vitest';

const { channel, removeChannel } = vi.hoisted(() => {
  const channel = vi.fn();
  const removeChannel = vi.fn();
  return { channel, removeChannel };
});

vi.mock('@/lib/supabase/client', () => ({
  supabase: { channel, removeChannel },
}));

import { closeAllRealtimeChannels, subscribeTable, subscribeToPermissionChanges } from '@/lib/supabase/realtime';

beforeEach(() => { closeAllRealtimeChannels(); vi.clearAllMocks(); });

describe('permission realtime invalidation', () => {
  it('AUD-14: late cleanup after a permission broadcast cannot destroy a replacement topic', () => {
    const channels: { on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> }[] = [];
    channel.mockImplementation(() => { const entry = { on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() }; channels.push(entry); return entry; });
    const projectId = '00000000-0000-4000-8000-000000000002';
    const userId = '00000000-0000-4000-8000-000000000001';
    const oldCleanup = subscribeTable('projects', { projectId, onEvent: vi.fn() });
    const status = vi.fn(); let newCleanup!: () => void;
    const permissionCleanup = subscribeToPermissionChanges(userId, () => {
      newCleanup = subscribeTable('projects', { projectId, onEvent: vi.fn(), onStatus: status });
    });
    channels[1].on.mock.calls[0][2]({ payload: { table: 'project_members', operation: 'UPDATE' } });
    expect(channels).toHaveLength(3);
    oldCleanup(); // The old focused screen is cleaned up after the new one subscribes.
    channels[2].subscribe.mock.calls[0][0]('SUBSCRIBED');
    expect(status).toHaveBeenLastCalledWith('connected', undefined);
    closeAllRealtimeChannels();
    expect(removeChannel).toHaveBeenCalledWith(channels[2]);
    newCleanup(); permissionCleanup();
  });
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
