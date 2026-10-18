import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeAllRealtimeChannels, closeResourceRealtimeChannels, subscribeMany, subscribeTable } from '@/lib/supabase/realtime';
import { clearReadFreshness, readInvalidation, setReadAccount, settleReadInvalidations } from '@/lib/local-cache/read-freshness';
const f = vi.hoisted(() => ({ channel: vi.fn(), remove: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { channel: f.channel, removeChannel: f.remove } }));
vi.mock('@/lib/local-cache/driver', async () => import('@/lib/local-cache/driver.web'));
const user = '00000000-0000-4000-8000-000000000001';
const channels: { on: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> }[] = [];
beforeEach(() => {
  closeAllRealtimeChannels(); clearReadFreshness(); setReadAccount(user); vi.clearAllMocks(); channels.length = 0;
  f.channel.mockImplementation(() => { const c = { on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() }; channels.push(c); return c; });
});
afterEach(async () => { await settleReadInvalidations(user); closeAllRealtimeChannels(); setReadAccount(null); });
it('shares a single private library channel, fences all template models before notifying readers, and cleans up by refcount', () => {
  const kinds: string[] = [];
  const callback = () => { kinds.push(readInvalidation(user, 'templates').kind!); expect(readInvalidation(user, 'template-items:one').kind).toBe('data'); };
  const off = subscribeMany(['task_templates', 'task_template_items'].map(table => ({ table, options: { templates: true, onEvent: callback } })));
  const extra = subscribeTable('task_templates', { templates: true, onEvent: vi.fn() });
  expect(f.channel).toHaveBeenCalledExactlyOnceWith('templates', { config: { private: true } });
  channels[0].on.mock.calls[0][2]({ payload: { table: 'task_template_items', operation: 'UPDATE' } });
  expect(kinds).toEqual(['data']); expect(readInvalidation(user, 'project:unrelated').kind).toBeNull();
  off(); expect(f.remove).not.toHaveBeenCalled(); extra(); expect(f.remove).toHaveBeenCalledOnce();
});
it('invalidates the library on initial join and every reconnect, including changes missed while disconnected', () => {
  const status = vi.fn(() => expect(readInvalidation(user, 'templates').kind).toBe('refresh'));
  const off = subscribeTable('task_templates', { templates: true, onEvent: vi.fn(), onStatus: s => { if (s === 'connected') status(); } });
  const notify = channels[0].subscribe.mock.calls[0][0]; notify('SUBSCRIBED');
  const before = readInvalidation(user, 'templates').version;
  notify('CLOSED'); notify('SUBSCRIBED');
  expect(readInvalidation(user, 'template:one').version).toBeGreaterThan(before); expect(status).toHaveBeenCalledTimes(2); off();
});
it('project permission changes preserve the global library, while account epochs fence delayed library events and rejoins', () => {
  const callback = vi.fn(); const off = subscribeTable('task_templates', { templates: true, onEvent: callback });
  closeResourceRealtimeChannels(); expect(f.remove).not.toHaveBeenCalled();
  const receive = channels[0].on.mock.calls[0][2]; receive({ payload: { table: 'task_templates', operation: 'INSERT' } }); expect(callback).toHaveBeenCalledOnce();
  setReadAccount(null); setReadAccount(user); receive({ payload: { table: 'task_templates', operation: 'DELETE' } });
  channels[0].subscribe.mock.calls[0][0]('SUBSCRIBED'); expect(callback).toHaveBeenCalledOnce(); off();
});
it('rejects ambiguous scopes and malformed messages', () => {
  const callback = vi.fn(); const status = vi.fn(); subscribeTable('task_templates', { templates: true, userId: user, onEvent: callback, onStatus: status });
  expect(status).toHaveBeenCalledWith('error', expect.any(String)); expect(f.channel).not.toHaveBeenCalled();
  const off = subscribeTable('task_templates', { templates: true, onEvent: callback });
  const receive = channels[0].on.mock.calls[0][2]; for (const payload of [null, {}, { payload: { table: 'task_templates', operation: 'TRUNCATE' } }]) receive(payload);
  expect(callback).not.toHaveBeenCalled(); off();
});
