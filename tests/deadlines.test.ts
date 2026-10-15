import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { averageChecklistProgress, deadlineState, deadlineSummary, formatUtcOffset, groupChecklistOverview, localDeadline, nextDeadlineBoundary, progressStatus, type ChecklistOverviewItem } from '@/features/projects/deadlines';
import { russianCount } from '@/lib/russian';
import { patchChecklistOverview } from '@/lib/local-cache/checklist-overview';
import { applyPullToEntries } from '@/lib/local-cache/pull-cache';
import { reconcileEntries, reconciledKeys } from '@/lib/local-cache/reconcile';
import type { CacheEntry, OfflineOperation } from '@/lib/local-cache/types';
import { selectChecklistHistory } from '@/features/projects/history-format';

const now = Date.parse('2026-10-15T12:00:00Z');
const item = (hours: number, percentage = 0) => ({ deadline_at: new Date(now + hours * 3_600_000).toISOString(), percentage });
const row = (id: string, hours: number, percentage = 0): ChecklistOverviewItem => ({ ...item(hours, percentage), id, task_id: 't', project_id: 'p', comment: null, is_completed: percentage === 100, sync_version: 2 });
const entry = (key: string, data: unknown): CacheEntry => ({ user_id: 'u', key, data: JSON.stringify(data), last_synced_at: '', schema_version: 1 });

describe('shared deadline state and aggregation', () => {
  it('uses exact 12-hour and deadline boundaries and only 100% completion', () => {
    expect(deadlineState(item(12.000001), now)).toBe('normal');
    expect(deadlineState(item(12), now)).toBe('urgent');
    expect(deadlineState(item(0.000001, 99), now)).toBe('urgent');
    expect(deadlineState(item(0, 99), now)).toBe('overdue');
    expect(deadlineState(item(-1, 100), now)).toBe('normal');
    expect(deadlineState(item(-1, 99), now)).toBe('overdue');
    expect(deadlineState({ ...item(-1), is_archived: true }, now)).toBe('normal');
    expect(deadlineState({ deadline_at: null, percentage: 0 }, now)).toBe('normal');
    expect(deadlineState({ deadline_at: 'invalid', percentage: 0 }, now)).toBe('normal');
  });
  it('counts checklists and prioritizes overdue over urgent, including after completion/removal', () => {
    const items = [row('1', -1), row('2', -1, 100), row('3', 1), row('4', 1), row('5', 24)];
    expect(deadlineSummary(items, now)).toEqual({ urgent: 2, overdue: 1, state: 'overdue' });
    items[0].percentage = 100;
    expect(deadlineSummary(items, now).state).toBe('urgent');
    items[2].deadline_at = null; items[3].percentage = 100;
    expect(deadlineSummary(items, now).state).toBe('normal');
    items[0].percentage = 99;
    expect(deadlineSummary(items, now).overdue).toBe(1);
    expect(groupChecklistOverview(items).tasks.get('t')).toHaveLength(5);
    expect(groupChecklistOverview(items).projects.get('p')).toHaveLength(5);
  });
  it('computes only the next active visual boundary', () => {
    expect(nextDeadlineBoundary([item(24), item(1)], now)).toBe(now + 3_600_000);
    expect(nextDeadlineBoundary([item(24)], now)).toBe(now + 12 * 3_600_000);
    expect(nextDeadlineBoundary([item(-1), item(1, 100)], now)).toBeNull();
    expect(progressStatus(averageChecklistProgress([{ percentage: 100 }, { percentage: 99 }]))).toBe('in_progress');
    expect(progressStatus(0)).toBe('not_started'); expect(progressStatus(100)).toBe('completed');
    expect(progressStatus(100, true)).toBe('archived');
  });
});

describe('Russian counts', () => {
  it.each([[1, 0], [2, 1], [5, 2], [11, 2], [12, 2], [14, 2], [21, 0], [22, 1], [25, 2], [101, 0], [111, 2], [112, 2], [114, 2], [121, 0], [0, 2]])('declines %i correctly', (count, ending) => {
    expect(russianCount(count, ['этап', 'этапа', 'этапов'])).toBe(`${count} ${['этап', 'этапа', 'этапов'][ending]}`);
    expect(russianCount(count, ['исполнитель', 'исполнителя', 'исполнителей'])).toBe(`${count} ${['исполнитель', 'исполнителя', 'исполнителей'][ending]}`);
    expect(russianCount(count, ['горящий дедлайн', 'горящих дедлайна', 'горящих дедлайнов'])).toBe(`${count} ${['горящий дедлайн', 'горящих дедлайна', 'горящих дедлайнов'][ending]}`);
  });
});

it('shows deadline events in the existing checklist history after completion and removal', () => {
  const entries = ['set', 'urgent', 'overdue', 'completed', 'reopened_overdue', 'removed'].map((deadline_event, id) => ({
    id, action: 'updated', entity_type: 'task_item_deadline', entity_id: 'item', user_id: null,
    created_at: '2026-10-15T12:00:00Z', old_data: {}, new_data: { deadline_event, title: 'Checklist', deadline_at: deadline_event === 'removed' ? null : '2026-10-16T12:00:00Z' },
  }));
  const history = selectChecklistHistory(entries);
  expect(history).toHaveLength(6);
  expect(history[3].changes[0]).toContain('Чек-лист с предупреждением выполнен');
  expect(history[4].changes[0]).toContain('Снова просрочен дедлайн');
  expect(history[5].changes).toEqual(['Дедлайн удалён']);
});

describe('date and timezone selection', () => {
  it('unambiguously converts noon and midnight', () => {
    expect(localDeadline(2026, 9, 20, 12, 34, 'AM')?.getHours()).toBe(0);
    expect(localDeadline(2026, 9, 20, 12, 34, 'PM')?.getHours()).toBe(12);
    expect(localDeadline(2026, 9, 20, 11, 59, 'PM')?.getHours()).toBe(23);
    expect(localDeadline(2026, 1, 31, 1, 0, 'AM')).toBeNull();
    expect(localDeadline(2026, 9, 20, 0, 60, 'AM')).toBeNull();
  });
  it.each([
    ['Europe/Simferopol', '2026-10-20T09:34:00.000Z'],
    ['America/New_York', '2026-10-20T16:34:00.000Z'],
    ['Asia/Kolkata', '2026-10-20T07:04:00.000Z'],
  ])('stores the chosen local noon as absolute UTC in %s', (timezone, expected) => {
    const url = pathToFileURL(resolve('src/features/projects/deadlines.ts')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {localDeadline} from ${JSON.stringify(url)}; process.stdout.write(localDeadline(2026,9,20,12,34,'PM').toISOString());`], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe(expected);
  });
  it('rejects a nonexistent wall time during the DST spring gap', () => {
    const url = pathToFileURL(resolve('src/features/projects/deadlines.ts')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {localDeadline} from ${JSON.stringify(url)}; process.stdout.write(String(localDeadline(2026,2,8,2,30,'AM')));`], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('null');
  });
  it('offers both absolute instants for a repeated hour and formats fractional timezone offsets', () => {
    const url = pathToFileURL(resolve('src/features/projects/deadlines.ts')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {localDeadlineCandidates} from ${JSON.stringify(url)}; process.stdout.write(JSON.stringify(localDeadlineCandidates(2026,10,1,1,30,'AM').map(d=>d.toISOString())));`], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
    expect(formatUtcOffset(-330)).toBe('UTC+05:30'); expect(formatUtcOffset(240)).toBe('UTC−04:00');
  });
});

describe('offline overview confirmation', () => {
  it('retains newer deadline versions and removes archived/deleted checklists', () => {
    const current = row('i', -1);
    const change = { cursor: 1, task_id: 't', task_item_id: 'i', change_type: 'upsert' as const, item: { id: 'i', percentage: 100, is_completed: true, comment: null, sync_version: 1, deadline_at: null } };
    expect(patchChecklistOverview([current], change)).toEqual([current]);
    expect(patchChecklistOverview([current], { ...change, item: { ...change.item, sync_version: 3, deadline_at: null } })[0].deadline_at).toBeNull();
    expect(patchChecklistOverview([current], { ...change, change_type: 'delete', item: null })).toEqual([]);
  });
  it('updates the global overview from the existing pull transaction even without cached detail items', () => {
    const current = row('i', -1);
    const after = applyPullToEntries([entry('checklist-overview', [current])], [{ cursor: 1, task_id: 't', task_item_id: 'i', change_type: 'upsert', item: { ...current, percentage: 100, is_completed: true, sync_version: 3 } }]);
    expect(deadlineSummary(JSON.parse(after[0].data), now).overdue).toBe(0);
  });
  it('reconciles an ACK atomically with counts and keeps other tasks when access is lost', () => {
    const operation = { user_id: 'u', project_id: 'p', task_id: 't', task_item_id: 'i' } as OfflineOperation;
    const keys = reconciledKeys(operation);
    const current = row('i', -1); const other = { ...row('other', -1), task_id: 'other' };
    const entries = keys.map((key) => key === 'checklist-overview' ? entry(key, [current, other]) : null);
    const server = { ...current, percentage: 100, is_completed: true, sync_version: 3 };
    const after = reconcileEntries(entries, operation, server, [server]);
    expect(deadlineSummary(JSON.parse(after[5]!.data), now).overdue).toBe(1);
    const denied = reconcileEntries(entries, operation, null, null);
    expect(JSON.parse(denied[5]!.data)).toEqual([other]);
  });
});
