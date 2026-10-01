import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineOperation, SyncConflict } from '@/lib/local-cache/types';
import type { SyncState } from '@/lib/local-cache/status';

const mocks = vi.hoisted(() => ({
  userId: 'user-a' as string | null,
  conflicts: vi.fn(), snapshot: vi.fn(), operations: vi.fn(), mine: vi.fn(), server: vi.fn(),
  retry: vi.fn(), discard: vi.fn(), back: vi.fn(), removeBack: vi.fn(),
  conflictListeners: new Set<(userId: string) => void>(), syncListeners: new Set<(userId: string) => void>(),
}));
vi.mock('react-native', () => ({
  View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable',
  Platform: { OS: 'web' }, Alert: { alert: vi.fn() },
  BackHandler: { addEventListener: mocks.back },
  StyleSheet: { create: (styles: unknown) => styles, absoluteFill: { position: 'absolute' } },
}));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ state: { isLoading: false, user: mocks.userId ? { id: mocks.userId } : null } }) }));
vi.mock('@/components/ui/theme-provider', () => ({ useTheme: () => ({ colors: {
  background: 'background', surface: 'surface', border: 'border', borderStrong: 'border',
  destructive: 'error', success: 'success', warning: 'warning',
} }) }));
vi.mock('@/components/ui/text', () => ({ ThemedText: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/lib/local-cache/conflicts', () => ({
  unresolvedConflicts: mocks.conflicts, chooseServer: mocks.server,
  subscribeConflictChanges: (callback: (userId: string) => void) => {
    mocks.conflictListeners.add(callback); return () => mocks.conflictListeners.delete(callback);
  },
}));
vi.mock('@/lib/local-cache/status', () => ({
  getSyncState: mocks.snapshot,
  subscribeSyncState: (callback: (userId: string) => void) => {
    mocks.syncListeners.add(callback); return () => mocks.syncListeners.delete(callback);
  },
}));
vi.mock('@/lib/local-cache/outbox', () => ({ listPendingOperations: mocks.operations }));
vi.mock('@/lib/local-cache/sync', () => ({
  chooseMine: mocks.mine, syncPendingOperations: vi.fn(async () => undefined),
  retryFailedOperation: mocks.retry, discardFailedOperation: mocks.discard,
}));

import { ConflictGate } from '@/lib/local-cache/ConflictGate';
import { RealtimeIndicator, compactSyncStatus } from '@/components/ui/realtime-indicator';

const clean: SyncState = { connectivity: 'online', isSyncing: false, pendingCount: 0, unsyncedCount: 0,
  failedCount: 0, conflictCount: 0, lastSuccessfulSyncAt: null, lastErrorKind: null, progress: null };
const conflict: SyncConflict = {
  conflict_id: 'conflict-a', user_id: 'user-a', project_id: 'project-a', task_id: 'task-a', task_item_id: 'item-a',
  operation_ids: ['op-a', 'op-b'], local_effective_state: { id: 'item-a', percentage: 100, is_completed: true, comment: null },
  server_state: { id: 'item-a', percentage: 50, is_completed: false, comment: null }, server_version: 2,
  conflicting_fields: ['progress'], project_name: 'Project', task_name: 'Task', item_name: 'Item',
  created_at: '', updated_at: '', status: 'unresolved',
};
const failed: OfflineOperation = { operation_id: 'op-a', user_id: 'user-a', project_id: 'project-a',
  task_id: 'task-a', task_item_id: 'item-a', type: 'set_task_item_state', payload: { completed: true },
  created_at: '', status: 'failed', sequence: 1, last_error: '42501 permission denied' };
const renderers: ReactTestRenderer[] = [];
let testWindow: EventTarget & { confirm: ReturnType<typeof vi.fn> };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function render(element: ReturnType<typeof createElement>) {
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(element); });
  renderers.push(renderer);
  return renderer;
}
function gate() { return createElement(ConflictGate, { children: createElement('Checklist', { testID: 'checklist' }, 'Checklist') }); }
function body(renderer: ReactTestRenderer) { return JSON.stringify(renderer.toJSON()); }
function blocked(renderer: ReactTestRenderer) { return renderer.root.findAllByProps({ accessibilityViewIsModal: true }).length > 0; }
function app(renderer: ReactTestRenderer) { return renderer.root.findByProps({ importantForAccessibility: blocked(renderer) ? 'no-hide-descendants' : 'auto' }); }
async function syncChanged() { await act(async () => { mocks.syncListeners.forEach((callback) => callback('user-a')); }); }
async function press(renderer: ReactTestRenderer, children: string) {
  await act(async () => { await renderer.root.findByProps({ children }).props.onPress(); });
}

beforeEach(() => {
  vi.resetAllMocks(); mocks.userId = 'user-a';
  mocks.conflictListeners.clear(); mocks.syncListeners.clear();
  mocks.conflicts.mockResolvedValue([]); mocks.snapshot.mockResolvedValue({ ...clean }); mocks.operations.mockResolvedValue([]);
  mocks.back.mockReturnValue({ remove: mocks.removeBack });
  mocks.mine.mockResolvedValue(undefined); mocks.server.mockResolvedValue(undefined);
  mocks.retry.mockResolvedValue(undefined); mocks.discard.mockResolvedValue(undefined);
  testWindow = Object.assign(new EventTarget(), { confirm: vi.fn(() => true) });
  vi.stubGlobal('window', testWindow); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const consoleError = console.error.bind(console);
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (String(args[0]).includes('react-test-renderer is deprecated')) return;
    consoleError(...args);
  });
});
afterEach(async () => {
  await act(async () => { renderers.splice(0).forEach((renderer) => renderer.unmount()); });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('ConflictGate blocks only durable unresolved conflicts', () => {
  it('renders children with no conflict and leaves Back/Escape alone', async () => {
    const renderer = await render(gate());
    expect(body(renderer)).toContain('Checklist'); expect(blocked(renderer)).toBe(false);
    expect(app(renderer).props.pointerEvents).toBe('auto'); expect(mocks.back).not.toHaveBeenCalled();
    const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    testWindow.dispatchEvent(escape); expect(escape.defaultPrevented).toBe(false);
  });
  it('renders children normally while conflict storage is still loading', async () => {
    const reading = deferred<SyncConflict[]>(); mocks.conflicts.mockReturnValue(reading.promise);
    const renderer = await render(gate());
    expect(body(renderer)).toContain('Checklist'); expect(blocked(renderer)).toBe(false);
    expect(body(renderer)).not.toContain('Проверка синхронизации'); expect(mocks.back).not.toHaveBeenCalled();
    await act(async () => { reading.resolve([]); }); expect(blocked(renderer)).toBe(false);
  });
  it('a storage error never creates a conflict or intercepts navigation', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.conflicts.mockRejectedValue(new Error('private raw storage details'));
    const renderer = await render(gate());
    expect(body(renderer)).toContain('Checklist'); expect(blocked(renderer)).toBe(false);
    expect(mocks.back).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith('[TaskTrace] Не удалось прочитать локальные конфликты.');
  });
  it('one real conflict blocks app interactions, Back and Escape', async () => {
    mocks.conflicts.mockResolvedValue([conflict]);
    const renderer = await render(gate());
    expect(blocked(renderer)).toBe(true); expect(app(renderer).props.pointerEvents).toBe('none');
    expect(body(renderer)).toContain('Ваш вариант'); expect(body(renderer)).toContain('Серверный вариант');
    expect(mocks.back.mock.calls[0][1]()).toBe(true);
    const escape = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });
    testWindow.dispatchEvent(escape); expect(escape.defaultPrevented).toBe(true);
  });
  it.each(['Оставить моё', 'Оставить серверное'])('unblocks immediately after durable resolution: %s', async (choice) => {
    const durable = deferred<void>();
    mocks.conflicts.mockResolvedValue([conflict]);
    (choice === 'Оставить моё' ? mocks.mine : mocks.server).mockReturnValue(durable.promise);
    const renderer = await render(gate());
    await press(renderer, choice); expect(blocked(renderer)).toBe(true);
    // Even if the next store read fails, the successfully resolved conflict must disappear.
    mocks.conflicts.mockRejectedValue(new Error('read failed'));
    await act(async () => { durable.resolve(); });
    expect(blocked(renderer)).toBe(false); expect(app(renderer).props.pointerEvents).toBe('auto');
    expect(mocks.removeBack).toHaveBeenCalled();
  });
  it('retains a real conflict when durable resolution fails', async () => {
    mocks.conflicts.mockResolvedValue([conflict]); mocks.mine.mockRejectedValue(new Error('Resolution failed'));
    const renderer = await render(gate()); await press(renderer, 'Оставить моё');
    expect(blocked(renderer)).toBe(true); expect(body(renderer)).toContain('Resolution failed');
  });
  it('ignores conflicts and late store reads from the previous account', async () => {
    const oldRead = deferred<SyncConflict[]>(); mocks.conflicts.mockReturnValueOnce(oldRead.promise);
    const renderer = await render(gate());
    mocks.userId = 'user-b'; await act(async () => { renderer.update(gate()); });
    await act(async () => { oldRead.resolve([conflict]); });
    expect(blocked(renderer)).toBe(false);
  });
  it('does not carry an already loaded conflict across an account switch', async () => {
    mocks.conflicts.mockResolvedValueOnce([conflict]); const renderer = await render(gate());
    expect(blocked(renderer)).toBe(true);
    mocks.userId = 'user-b'; mocks.conflicts.mockReturnValue(new Promise(() => undefined));
    await act(async () => { renderer.update(gate()); }); expect(blocked(renderer)).toBe(false);
  });
  it('a late resolution from another account does not cancel the current account store read', async () => {
    const durable = deferred<void>(); const currentRead = deferred<SyncConflict[]>();
    mocks.conflicts.mockResolvedValueOnce([conflict]); mocks.server.mockReturnValue(durable.promise);
    const renderer = await render(gate()); await press(renderer, 'Оставить серверное');
    mocks.userId = 'user-b'; mocks.conflicts.mockReturnValue(currentRead.promise);
    await act(async () => { renderer.update(gate()); });
    await act(async () => { durable.resolve(); });
    await act(async () => { currentRead.resolve([{ ...conflict, user_id: 'user-b', conflict_id: 'conflict-b' }]); });
    expect(blocked(renderer)).toBe(true);
  });
  it('ignores an obsolete read that finishes after a newer conflict refresh', async () => {
    const oldRead = deferred<SyncConflict[]>(); mocks.conflicts.mockReturnValueOnce(oldRead.promise);
    const renderer = await render(gate()); mocks.conflicts.mockResolvedValue([conflict]);
    await act(async () => { mocks.conflictListeners.forEach((callback) => callback('user-a')); });
    await act(async () => { oldRead.resolve([]); }); expect(blocked(renderer)).toBe(true);
  });
});

describe('compact sync status and non-blocking failed actions', () => {
  it.each([
    [{ connectivity: 'offline', unsyncedCount: 3, pendingCount: 3 }, 'Синхронизация: офлайн · 3 несинхр.', 'warning'],
    [{ connectivity: 'offline' }, 'Синхронизация: офлайн', 'warning'],
    [{ isSyncing: true }, 'Синхронизация: в процессе', 'warning'],
    [{ isSyncing: true, unsyncedCount: 3 }, 'Синхронизация: в процессе · 3 несинхр.', 'warning'],
    [{ unsyncedCount: 3, pendingCount: 3 }, 'Синхронизация: ожидает · 3 несинхр.', 'warning'],
    [{}, 'Синхронизация: подключено', 'success'],
    [{ failedCount: 2, unsyncedCount: 2 }, 'Синхронизация: ошибка · 2 несинхр.', 'destructive'],
    [{ conflictCount: 1, unsyncedCount: 3 }, 'Синхронизация: конфликт · 3 несинхр.', 'destructive'],
  ] as const)('renders %s', async (patch, text, tone) => {
    mocks.snapshot.mockResolvedValue({ ...clean, ...patch });
    const renderer = await render(createElement(RealtimeIndicator, { status: 'connected' }));
    expect(body(renderer)).toContain(text); expect(blocked(renderer)).toBe(false);
    expect(compactSyncStatus('connected', { ...clean, ...patch }).tone).toBe(tone);
  });
  it('uses conflict > failed > offline > syncing > waiting > reconnecting priority', () => {
    const snapshot: SyncState = { ...clean, connectivity: 'offline', isSyncing: true, conflictCount: 1, failedCount: 1, unsyncedCount: 3 };
    expect(compactSyncStatus('reconnecting', snapshot).text).toContain('конфликт');
    snapshot.conflictCount = 0; expect(compactSyncStatus('reconnecting', snapshot).text).toContain('ошибка');
    snapshot.failedCount = 0; expect(compactSyncStatus('reconnecting', snapshot).text).toContain('офлайн');
    snapshot.connectivity = 'online'; expect(compactSyncStatus('reconnecting', snapshot).text).toContain('в процессе');
    snapshot.isSyncing = false; expect(compactSyncStatus('reconnecting', snapshot).text).toContain('ожидает');
    snapshot.unsyncedCount = 0; expect(compactSyncStatus('reconnecting', snapshot).text).toBe('Синхронизация: переподключение...');
  });
  it('does not treat a connected Realtime channel as an acknowledged offline operation', () => {
    expect(compactSyncStatus('connected', { ...clean, unsyncedCount: 1 }).text).toBe('Синхронизация: ожидает · 1 несинхр.');
    expect(compactSyncStatus('connecting', clean).text).toBe('Синхронизация: подключение...');
    expect(compactSyncStatus('connected', null)).toEqual({ text: 'Синхронизация: подключение...', tone: 'warning' });
  });
  it('exposes retry/discard only in an expandable inline section and calls the existing actions', async () => {
    mocks.snapshot.mockResolvedValue({ ...clean, failedCount: 1, unsyncedCount: 1 }); mocks.operations.mockResolvedValue([failed]);
    const renderer = await render(createElement(RealtimeIndicator, { status: 'connected' }));
    expect(body(renderer)).not.toContain('Отменить локальное изменение');
    await act(async () => { renderer.root.findByProps({ accessibilityRole: 'button' }).props.onPress(); });
    expect(blocked(renderer)).toBe(false); expect(body(renderer)).toContain('Отменить локальное изменение');
    await press(renderer, 'Повторить'); expect(mocks.retry).toHaveBeenCalledWith('user-a', 'op-a');
    testWindow.confirm.mockReturnValueOnce(false);
    await press(renderer, 'Отменить локальное изменение'); expect(mocks.discard).not.toHaveBeenCalled();
    await press(renderer, 'Отменить локальное изменение'); expect(mocks.discard).toHaveBeenCalledWith('user-a', 'op-a');
  });
  it('a sync-state read failure stays compact, recovers, and never blocks the app', async () => {
    mocks.snapshot.mockRejectedValueOnce(new Error('private storage details'));
    const renderer = await render(createElement(RealtimeIndicator, { status: 'connected' }));
    expect(body(renderer)).toContain('Синхронизация: ошибка'); expect(blocked(renderer)).toBe(false);
    expect(body(renderer)).not.toContain('private storage details');
    await syncChanged(); expect(body(renderer)).toContain('Синхронизация: подключено');
  });
  it('does not show counts or failed actions from a previous account', async () => {
    mocks.snapshot.mockResolvedValueOnce({ ...clean, failedCount: 1, unsyncedCount: 1 }); mocks.operations.mockResolvedValueOnce([failed]);
    const renderer = await render(createElement(RealtimeIndicator, { status: 'connected' }));
    await act(async () => { renderer.root.findByProps({ accessibilityRole: 'button' }).props.onPress(); });
    mocks.userId = 'user-b'; mocks.snapshot.mockReturnValue(new Promise(() => undefined));
    await act(async () => { renderer.update(createElement(RealtimeIndicator, { status: 'connected' })); });
    expect(body(renderer)).not.toContain('несинхр.'); expect(body(renderer)).not.toContain('Отменить локальное изменение');
  });
  it('keeps the compact conflict status and the blocking Gate tied to real stored conflicts', async () => {
    mocks.snapshot.mockResolvedValue({ ...clean, conflictCount: 1, unsyncedCount: 2 });
    mocks.conflicts.mockResolvedValue([conflict]);
    const renderer = await render(createElement(ConflictGate, {
      children: createElement(RealtimeIndicator, { status: 'connected' }),
    }));
    expect(body(renderer)).toContain('Синхронизация: конфликт · 2 несинхр.'); expect(blocked(renderer)).toBe(true);
  });
});
