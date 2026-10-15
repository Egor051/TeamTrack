import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ receive: (_payload: unknown) => {}, status: (_status: string) => {}, channel: vi.fn(), remove: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { channel: f.channel, removeChannel: f.remove } }));
import { closeAllRealtimeChannels, subscribeTable } from '@/lib/supabase/realtime';
import { clearReadFreshness, readInvalidation, setReadAccount, settleReadInvalidations } from '@/lib/local-cache/read-freshness';
const user = '00000000-0000-4000-8000-000000000001';
const project = '00000000-0000-4000-8000-000000000002';
const task = '00000000-0000-4000-8000-000000000003';
beforeEach(() => {
  closeAllRealtimeChannels(); clearReadFreshness(); setReadAccount(user);
  f.channel.mockImplementation(() => ({ on(_event: string, _filter: unknown, receive: typeof f.receive) { f.receive = receive; return this; }, subscribe(status: typeof f.status) { f.status = status; return this; } }));
});
afterEach(async () => { closeAllRealtimeChannels(); await settleReadInvalidations(user); clearReadFreshness(); setReadAccount(null); vi.clearAllMocks(); });
it('fences all item-derived models before invoking any user-topic listener', () => {
  const listener = vi.fn(() => {
    for (const key of [`task:${task}`, `tasks:${project}`, `task-stats:${project}:active`, `my-tasks:${user}`, 'checklist-overview'])
      expect(readInvalidation(user, key).kind).toBe('data');
  });
  subscribeTable('task_items', { userId: user, onEvent: listener });
  f.receive({ payload: { table: 'task_items', operation: 'UPDATE' } });
  expect(listener).toHaveBeenCalledOnce();
});
it('revalidates a fresh cached overview after socket reconnect, without polling', () => {
  subscribeTable('task_items', { userId: user, onEvent: vi.fn() });
  f.status('SUBSCRIBED'); const before = readInvalidation(user, 'checklist-overview').version;
  expect(readInvalidation(user, 'checklist-overview').kind).toBe('refresh');
  f.status('TIMED_OUT'); f.status('SUBSCRIBED');
  expect(readInvalidation(user, 'checklist-overview').version).toBeGreaterThan(before);
  expect(readInvalidation(user, `my-tasks:${user}`).kind).toBe('refresh');
});
it('a project-scoped item event invalidates both the parent task list and account deadline counts', () => {
  subscribeTable('task_items', { projectId: project, onEvent: vi.fn() });
  f.receive({ payload: { table: 'task_items', operation: 'UPDATE' } });
  expect(readInvalidation(user, `tasks:${project}`).kind).toBe('data');
  expect(readInvalidation(user, `task:${task}`).kind).toBe('data');
  expect(readInvalidation(user, 'checklist-overview').kind).toBe('data');
});
