import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ user: { id: 'user' }, params: { id: 'project', taskId: 'stage' },
  getTask: vi.fn(), editors: vi.fn(), replace: vi.fn(), items: [] as Record<string, unknown>[], role: 'owner',
  comment: vi.fn(), percentage: vi.fn(), title: vi.fn(), deadline: vi.fn(), perform: vi.fn(),
  load: async () => {}, refresh: async () => { await f.load(); } }));
vi.mock('expo-router', () => ({ router: { replace: f.replace }, useLocalSearchParams: () => f.params, useFocusEffect: (callback: () => void | (() => void)) => useEffect(callback, [callback]) }));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable', StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 390 }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@/features/auth/AuthProvider', () => ({ useUser: () => f.user }));
vi.mock('@/features/auth/PermissionProvider', () => ({ usePermissionVersion: () => 0 }));
vi.mock('@/lib/connectivity/use-online-recovery', () => ({ useOnlineRecovery: () => {} }));
vi.mock('@/lib/local-cache/read-freshness', () => ({ isReadAccessPending: () => false }));
vi.mock('@/lib/local-cache/use-read-model-updates', () => ({ useReadModelUpdates: (load: () => Promise<void>) => { f.load = load; return { scheduleRefresh: f.refresh, refreshFromServer: f.refresh }; } }));
vi.mock('@/lib/local-cache/cache', () => ({ SupersededReadError: class SupersededReadError extends Error {}, activeCacheUserId: async () => f.user.id,
  getCached: async () => null, isTaskProjectBlocked: async () => false, isCachedResult: () => false, isExplicitAccessError: (error: { code?: string }) => error?.code === '42501', isTransportFailure: () => false }));
vi.mock('@/lib/local-cache/runtime-config', () => ({ buildSyncEnabled: () => false }));
vi.mock('@/lib/local-cache/outbox', () => ({ listPendingOperations: async () => [], offlineWriteEnabled: () => false }));
vi.mock('@/lib/local-cache/edit', () => ({ performSupportedEdit: f.perform }));
vi.mock('@/lib/local-cache/sync', () => ({ subscribeSyncChanges: () => () => {} }));
vi.mock('@/lib/local-cache/repository', () => ({ ChecklistLocalRepository: {} }));
vi.mock('@/lib/supabase/realtime', () => ({ subscribeMany: () => () => {} }));
vi.mock('@/features/projects/use-deadline-clock', () => ({ useDeadlineClock: () => Date.now() }));
vi.mock('@/features/projects/task-members-panel', () => ({ TaskMembersPanel: 'TaskMembersPanel' }));
vi.mock('@/features/projects/projects', () => ({ getTask: f.getTask, getTaskProjectContext: async () => ({ id: 'project', name: 'Project', role: 'owner', status: 'active' }),
  listTaskItems: async (_task: string, mode: string) => f.items.filter((item) => Boolean(item.is_archived) === (mode === 'archived')).map((item) => ({ ...item })),
  getMyTaskRole: async () => f.role, listTaskParticipants: async () => [], listTaskAssignees: async () => [], listTaskItemLastEditors: f.editors,
  setTaskItemComment: f.comment, setTaskItemPercentage: f.percentage, updateTaskItem: f.title, setTaskItemDeadline: f.deadline,
  getTaskItemForEdit: async () => ({ ...f.items[0] }) }));
vi.mock('@/components/ui/theme-provider', () => ({ useTheme: () => ({ colors: {} }) }));
vi.mock('@/components/ui/screen', () => ({ Screen: 'Screen' }));
vi.mock('@/components/ui/page-header', () => ({ PageHeader: 'PageHeader' }));
vi.mock('@/components/ui/text', () => ({ ThemedText: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/card', () => ({ Card: 'Card' }));
vi.mock('@/components/ui/badge', () => ({ Badge: 'Badge' }));
vi.mock('@/components/ui/task-status', () => ({ TaskStatus: 'TaskStatus' }));
vi.mock('@/components/ui/progress', () => ({ Progress: 'Progress' }));
vi.mock('@/components/ui/checkbox', () => ({ Checkbox: 'Checkbox' }));
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: 'ConfirmDialog' }));
vi.mock('@/components/ui/states', () => ({ ErrorState: 'ErrorState', EmptyState: 'EmptyState', LoadingState: 'LoadingState' }));
vi.mock('@/components/ui/error-message', () => ({ ErrorMessage: 'ErrorMessage' }));
vi.mock('@/components/ui/realtime-indicator', () => ({ RealtimeIndicator: 'RealtimeIndicator' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: 'Textarea' }));
vi.mock('@/components/ui/modal-layer', () => ({ ModalLayer: 'ModalLayer' }));
vi.mock('@/components/ui/deadline-status', () => ({ ChecklistDeadline: 'ChecklistDeadline', DeadlineBadge: 'DeadlineBadge', DeadlineCard: 'DeadlineCard' }));
vi.mock('@/components/ui/deadline-picker', () => ({ DeadlinePicker: 'DeadlinePicker' }));
import TaskScreen from '@/app/(app)/projects/[id]/tasks/[taskId]';
import { SupersededReadError } from '@/lib/local-cache/cache';
let screen: ReactTestRenderer;
const stage = (title = 'Initial', id = 'stage') => ({ id, project_id: 'project', title, description: null, status: 'not_started' });
const body = () => JSON.stringify(screen.toJSON(), (key, value) => key === '_owner' ? undefined : value);
beforeEach(() => { vi.clearAllMocks(); f.params = { id: 'project', taskId: 'stage' }; f.getTask.mockResolvedValue(stage()); f.editors.mockResolvedValue([]);
  f.items = []; f.role = 'owner'; f.deadline.mockReset().mockResolvedValue(undefined);
  f.perform.mockImplementation(async (input: { onlineAction: () => Promise<void> }) => { await input.onlineAction(); return { kind: 'server' }; });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(async () => { await act(async () => screen?.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount() { await act(async () => { screen = create(createElement(TaskScreen)); }); }
it('an ACL-superseded read leaves the mounted stage and draft intact; concurrent details require explicit review', async () => {
  await mount(); await act(async () => screen.root.findByProps({ children: 'Редактировать' }).props.onPress());
  await act(async () => screen.root.findByProps({ label: 'Название' }).props.onChangeText('My draft'));
  f.getTask.mockRejectedValueOnce(new SupersededReadError('Fence replaced'));
  await act(async () => f.refresh());
  expect(screen.root.findByProps({ label: 'Название' }).props.value).toBe('My draft');
  expect(body()).not.toContain('Не удалось обновить этап'); expect(f.replace).not.toHaveBeenCalled();
  f.getTask.mockResolvedValue(stage('Server title'));
  await act(async () => f.refresh());
  expect(body()).toContain('Server title'); expect(screen.root.findByProps({ label: 'Название' }).props.value).toBe('My draft');
  expect(screen.root.findByProps({ children: 'Сохранить' }).props.disabled).toBe(true);
  await act(async () => screen.root.findByProps({ children: 'Продолжить с моим черновиком' }).props.onPress());
  expect(screen.root.findByProps({ children: 'Сохранить' }).props.disabled).toBe(false);
});
it('a failed optional editor RPC does not discard the stage and reports its diagnostic step', async () => {
  f.editors.mockRejectedValue({ code: 'PGRST202', message: 'internal details' }); await mount();
  expect(body()).toContain('Initial'); expect(body()).toContain('дополнительных данных');
  expect(body()).not.toContain('internal details'); expect(f.replace).not.toHaveBeenCalled();
  expect(console.warn).toHaveBeenCalledWith('[TaskTrace] task read failed', expect.objectContaining({ step: 'last-editors', code: 'PGRST202' }));
});
it('a real read failure keeps the current draft and offers recovery', async () => {
  await mount(); await act(async () => screen.root.findByProps({ children: 'Редактировать' }).props.onPress());
  await act(async () => screen.root.findByProps({ label: 'Название' }).props.onChangeText('Unsaved'));
  f.getTask.mockRejectedValue(new Error('Unexpected RPC failure')); await act(async () => f.refresh());
  expect(screen.root.findByProps({ label: 'Название' }).props.value).toBe('Unsaved'); expect(body()).toContain('Не удалось обновить этап.');
  expect(screen.root.findAllByProps({ children: 'Обновить данные' })).toHaveLength(1);
});
it('a real RLS denial from a supplementary stage read clears the view instead of falling back to old rows', async () => {
  await mount(); f.editors.mockRejectedValue({ code: '42501', message: 'access denied' });
  await act(async () => f.refresh());
  expect(body()).not.toContain('Initial'); expect(f.replace).toHaveBeenCalledWith('/projects');
});
it('a late response from the previous stage cannot overwrite a newly opened route', async () => {
  let resolve!: (value: unknown) => void;
  f.getTask.mockImplementationOnce(() => new Promise((done) => { resolve = done; })); await mount();
  f.params = { id: 'project', taskId: 'new-stage' }; f.getTask.mockResolvedValue(stage('New stage', 'new-stage'));
  await act(async () => screen.update(createElement(TaskScreen)));
  await act(async () => resolve(stage('Late old stage')));
  expect(body()).toContain('New stage'); expect(body()).not.toContain('Late old stage');
});
const item = () => ({ id: 'item', task_id: 'stage', title: 'Checklist item', description: 'Independent work instructions', comment: 'Original comment', percentage: 20,
  is_completed: false, is_archived: false, sync_version: 1, position: 1, deadline_at: null });
const button = (label: string) => screen.root.findByProps({ children: label });
async function details() { await act(async () => button('Детали').props.onPress()); }
it('BUG-01/09 preserves a comment draft, displays instructions and requires explicit review before using the new version', async () => {
  f.items = [item()]; await mount(); await details(); expect(body()).toContain('Independent work instructions');
  await act(async () => button('Изменить комментарий').props.onPress());
  await act(async () => screen.root.findByProps({ label: 'Комментарий к пункту' }).props.onChangeText('My draft'));
  f.items = [{ ...item(), comment: 'Remote comment', sync_version: 2 }]; await act(async () => f.refresh());
  expect(screen.root.findByProps({ label: 'Комментарий к пункту' }).props.value).toBe('My draft');
  expect(button('Сохранить комментарий').props.disabled).toBe(true); expect(f.comment).not.toHaveBeenCalled();
  await act(async () => button('Продолжить с моим черновиком пункта').props.onPress());
  await act(async () => button('Сохранить комментарий').props.onPress());
  expect(f.comment).toHaveBeenCalledWith('item', 'My draft', 2);
  expect(f.perform.mock.calls.at(-1)?.[0].itemVersion).toBe(2);
});
it('BUG-01 preserves the original version of an edited percentage through a background reload', async () => {
  f.items = [item()]; await mount(); await details();
  const field = () => screen.root.findByProps({ label: 'Прогресс, от 1 до 100%' });
  await act(async () => field().props.onChangeText('40'));
  f.items = [{ ...item(), percentage: 70, sync_version: 2 }]; await act(async () => f.refresh());
  expect(field().props.value).toBe('40'); expect(button('Сохранить прогресс').props.disabled).toBe(true);
  await act(async () => button('Продолжить с моим черновиком пункта').props.onPress());
  await act(async () => button('Сохранить прогресс').props.onPress()); expect(f.percentage).toHaveBeenCalledWith('item', 40, 2);
});
it('BUG-01 applies CAS to a renamed item and keeps its text during a remote rename', async () => {
  f.items = [item()]; await mount(); await details(); await act(async () => button('Изменить текст').props.onPress());
  await act(async () => screen.root.findByProps({ label: 'Текст пункта' }).props.onChangeText('My title'));
  f.items = [{ ...item(), title: 'Remote title', sync_version: 2 }]; await act(async () => f.refresh());
  expect(button('Сохранить').props.disabled).toBe(true); expect(screen.root.findByProps({ label: 'Текст пункта' }).props.value).toBe('My title');
  await act(async () => button('Продолжить с моим черновиком пункта').props.onPress());
  await act(async () => button('Сохранить').props.onPress()); expect(f.title).toHaveBeenCalledWith('item', 'My title', 2);
});
it('BUG-08 retries a deadline only after accepting the authoritative version without discarding the chosen date', async () => {
  f.items = [item()]; await mount(); await details(); await act(async () => button('Установить дедлайн').props.onPress());
  f.items = [{ ...item(), sync_version: 2 }]; f.deadline.mockRejectedValueOnce({ code: 'PT409' });
  const picker = () => screen.root.find((node) => String(node.type) === 'DeadlinePicker'); const chosen = '2030-01-01T12:30:00Z';
  await act(async () => picker().props.onSave(chosen)); expect(f.deadline).toHaveBeenLastCalledWith('item', chosen, 1);
  expect(picker().props.onResolveConflict).toBeTypeOf('function');
  await act(async () => picker().props.onResolveConflict()); await act(async () => picker().props.onSave(chosen));
  expect(f.deadline).toHaveBeenLastCalledWith('item', chosen, 2); expect(screen.root.findAll((node) => String(node.type) === 'DeadlinePicker')).toHaveLength(0);
});
it('BUG-11 retains the active/archive switch after losing checklist administration', async () => {
  f.items = [item(), { ...item(), id: 'archived', title: 'Archived item', is_archived: true }]; await mount();
  const toggle = () => screen.root.findByProps({ accessibilityLabel: 'Пункты чек-листа' });
  await act(async () => toggle().props.onChange('archived')); f.role = 'member'; await act(async () => f.refresh());
  expect(toggle().props.value).toBe('archived'); await act(async () => toggle().props.onChange('active'));
  expect(body()).toContain('Checklist item'); expect(toggle().props.value).toBe('active');
});
