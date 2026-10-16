import { expect, it } from 'vitest';
import { matchesNotification, notificationTone, NotificationReadState } from '@/features/notifications/notification-state';
import type { Notification } from '@/features/notifications/notifications';
const notice = (props: Partial<Notification> = {}): Notification => ({ id: 'a', user_id: 'u', project_id: 'p', task_id: 't', type: 'task_item_changed',
  data: { deadline_event: 'overdue' }, dedupe_key: 'test', created_at: '2026-10-16T12:30:00Z', title: 'Notice', body: '', is_read: false, read_at: null, ...props });
it('a pending and acknowledged read cannot revert through arbitrarily ordered HTTP, cache or Realtime snapshots', () => {
  const state = new NotificationReadState(); const row = notice(); const ids = state.begin([row]);
  expect(state.apply([row])[0].is_read).toBe(true);
  state.confirm(ids);
  for (const fresh of [notice({ is_read: true }), row, notice({ title: 'Stale response' }), row]) expect(state.apply([fresh])[0].is_read).toBe(true);
});
it('an RPC failure rolls back only its pending read while a concurrent successful read remains confirmed', () => {
  const state = new NotificationReadState(); const rows = [notice(), notice({ id: 'b' }), notice({ id: 'c', is_read: true })];
  const first = state.begin([rows[0]]); const second = state.begin([rows[1]]); state.confirm(second);
  const rolledBack = state.rollback(first, state.apply(rows));
  expect(rolledBack.find((row) => row.id === 'a')?.is_read).toBe(false);
  expect(rolledBack.filter((row) => row.id !== 'a').every((row) => row.is_read)).toBe(true);
  expect(state.apply([rows[1]])[0].is_read).toBe(true);
});
it('mark all never marks a new notification that arrived after the action began', () => {
  const state = new NotificationReadState(); const ids = state.begin([notice()]); state.confirm(ids);
  expect(state.apply([notice(), notice({ id: 'later' })]).map((row) => row.is_read)).toEqual([true, false]);
});
it('a concurrent confirmed server read survives failure of the local RPC', () => {
  const state = new NotificationReadState(); const row = notice(); const ids = state.begin([row]);
  const server = state.accept([notice({ is_read: true, read_at: new Date().toISOString() })]);
  expect(state.rollback(ids, server)[0].is_read).toBe(true);
});
it('combines project, stage, action, read and exact date/time bounds after every Realtime update', () => {
  const filters = { projectId: 'p', taskId: 't', action: 'deadline:overdue', read: 'unread' as const, from: '2026-10-16T12:00:00Z', to: '2026-10-16T13:00:00Z' };
  expect(matchesNotification(notice(), filters)).toBe(true);
  for (const row of [notice({ project_id: 'other' }), notice({ task_id: 'other' }), notice({ created_at: '2026-10-16T13:01:00Z' }), notice({ is_read: true }), notice({ data: { deadline_event: 'urgent' } })]) expect(matchesNotification(row, filters)).toBe(false);
  expect(matchesNotification(notice({ is_read: true }), { ...filters, read: 'read' })).toBe(true);
});
it('deadline severity comes from structured events and remains independent from read state or title', () => {
  expect(notificationTone(notice({ title: 'Normal text' }))).toBe('danger');
  expect(notificationTone(notice({ is_read: true }))).toBe('danger');
  expect(notificationTone(notice({ data: { deadline_event: 'urgent' } }))).toBe('warning');
  expect(notificationTone(notice({ title: 'Просрочен дедлайн', data: { deadline_event: 'removed' } }))).toBe('neutral');
});
