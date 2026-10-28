import { describe, expect, it, vi } from 'vitest';
import { OperationError, annotateError, classifyError, errorContext, storageError } from '@/lib/errors/operation-error';
import { userMessage } from '@/lib/errors/user-message';
import { reportClientError, subscribeClientErrors } from '@/lib/errors/error-events';
import { createErrorEvent, eventFingerprint } from '@/lib/diagnostics/event';
import { diagnosticEvent } from './client-error-fixtures';
import { eventBytes, validClientErrorEvent } from '../supabase/functions/_shared/client-error-schema';

describe('client error classification and safe projection', () => {
  it.each([
    [new OperationError('local_data', 'TT_LOCAL_SNAPSHOT_MISSING', 'enqueue'), 'local_data', 'синхронизируйте'],
    [new OperationError('outbox_blocked', 'TT_OUTBOX_BLOCKED', 'enqueue'), 'outbox_blocked', 'индикатор'],
    [{ code: 'PT409', message: 'SQL detail' }, 'conflict', 'черновик'],
    [{ code: '42501', message: 'no access to active task item' }, 'permission', 'Доступ запрещён'],
    [{ code: 'PGRST301', message: 'JWT expired' }, 'session', 'сеанс'],
    [{ status: 401, message: 'anything' }, 'session', 'сеанс'],
    [new Error('Failed to fetch'), 'server', 'сервером'],
    [Object.assign(new Error('secret'), { name: 'QuotaExceededError' }), 'storage_full', 'места'],
    [Object.assign(new Error('secret'), { name: 'VersionError' }), 'storage', 'хранилище'],
    [new OperationError('write_disabled', 'TT_WRITE_DISABLED', 'capabilities'), 'write_disabled', 'отключены'],
    [new Error('secret SQL arbitrary token'), 'unknown', 'Fallback'],
  ])('classifies %o as %s without leaking internals', (error, kind, text) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(classifyError(error)).toBe(kind);
    const message = userMessage(error, 'Fallback');
    expect(message).toContain(text); expect(message).not.toMatch(/secret|SQL detail|arbitrary token/);
    vi.restoreAllMocks();
  });
  it('preserves the original exception, code, innermost stage and cause', () => {
    const cause = Object.assign(new Error('device detail'), { code: 'SQLITE_FULL' });
    const error = new OperationError('storage_full', 'TT_STORAGE_FULL', 'storage_write', { cause });
    expect(annotateError(error, { stage: 'ui', operation: 'set_task_item_comment' })).toBe(error);
    expect(errorContext(error)).toMatchObject({ stage: 'storage_write', operation: 'set_task_item_comment' });
    expect(error.cause).toBe(cause); expect(storageError(cause, 'storage_write')).toBe(cause);
  });
  it('records the snapshot guard at failure even if asynchronous recovery has already repaired the cache', () => {
    const error = new OperationError('local_data', 'TT_LOCAL_SNAPSHOT_MISSING', 'enqueue');
    const event = createErrorEvent(error, {}, { ...diagnosticEvent(), cache: { snapshot: 'valid', version: 4 } });
    expect(event.cache).toEqual({ snapshot: 'missing', version: null });
  });
  it('observers never break the operation or recursively report their failures', () => {
    const observer = vi.fn(() => { throw new Error('logger broken'); });
    const stop = subscribeClientErrors(observer);
    expect(() => reportClientError(new Error())).not.toThrow(); expect(observer).toHaveBeenCalledOnce(); stop();
  });
  it('drops messages, tokens, comments, headers, resource IDs and arbitrary properties at every cause depth', () => {
    const secret = 'CANARY-password-refresh-access-token-private-comment';
    const error = Object.assign(new Error(secret), { code: secret, name: secret, headers: { Authorization: secret }, request: { body: secret }, cause: Object.assign(new TypeError(secret), { code: '42501' }) });
    error.stack = `${secret}\n at arbitrary (${secret}:1:2)\n at write (https://tasktrace.ru/_expo/static/js/web/entry-${'a'.repeat(32)}.js:12:34)`;
    const state = diagnosticEvent();
    const event = createErrorEvent(error, { userId: secret, taskId: secret, itemId: secret, operation: 'set_task_item_comment' }, state);
    expect(validClientErrorEvent(event)).toBe(true);
    expect(JSON.stringify(event)).not.toContain(secret);
    expect(event.error).toMatchObject({ name: 'UnknownException', code: 'OTHER', causes: [{ name: 'TypeError', code: '42501' }], frames: [{ module: 'web_bundle', line: 12, column: 34 }] });
    expect(eventFingerprint(event)).toBe(eventFingerprint({ ...event, event_id: crypto.randomUUID() }));
  });
  it('bounds cyclic causes and rejects unknown or nested confidential fields', () => {
    const e = new Error('private'); Object.assign(e, { cause: e });
    expect(createErrorEvent(e, {}, diagnosticEvent()).error.causes).toEqual([]);
    const event = diagnosticEvent();
    for (const bad of [{ ...event, user_id: crypto.randomUUID() }, { ...event, error: { ...event.error, message: 'private' } },
      { ...event, cache: { ...event.cache, data: [] } }, { ...event, outbox: { ...event.outbox, payload: {} } },
      { ...event, app_build: 'secret-key' }, { ...event, error: { ...event.error, causes: [{ name: 'Error', code: 'NONE', token: 'x' }] } }])
      expect(validClientErrorEvent(bad)).toBe(false);
    expect(eventBytes({ text: 'я' })).toBeGreaterThan(JSON.stringify({ text: 'я' }).length);
    expect(eventBytes(event)).toBeLessThan(4096);
  });
});
