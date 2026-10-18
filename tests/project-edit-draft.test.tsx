import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ProjectScreen from '@/app/(app)/projects/[id]';
const f = vi.hoisted(() => ({ id: 'project', get: vi.fn(), save: vi.fn(), refresh: null as null | (() => Promise<void>), event: null as null | (() => void) }));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', RefreshControl: 'RefreshControl', StyleSheet: { create: (v: unknown) => v }, useWindowDimensions: () => ({ width: 1200 }) }));
vi.mock('expo-router', () => ({ router: { dismissTo: vi.fn(), replace: vi.fn(), push: vi.fn() }, useLocalSearchParams: () => ({ id: f.id }), useFocusEffect: (fn: () => void) => useEffect(fn, [fn]) }));
vi.mock('@/features/auth/AuthProvider', () => ({ useUser: () => ({ id: 'owner' }) }));
vi.mock('@/features/auth/PermissionProvider', () => ({ usePermissionVersion: () => 0 }));
vi.mock('@/features/projects/projects', () => ({ getProject: f.get, updateProject: f.save, listTasksWithStats: async () => [] }));
vi.mock('@/features/projects/project-members-panel', () => ({ ProjectMembersPanel: 'ProjectMembersPanel' }));
vi.mock('@/features/projects/checklist-overview', () => ({ listChecklistOverview: async () => [] }));
vi.mock('@/features/projects/use-deadline-clock', () => ({ useDeadlineClock: () => Date.now() }));
vi.mock('@/lib/supabase/realtime', () => ({ subscribeMany: (specs: { options: { onEvent: () => void } }[]) => { f.event = specs[0].options.onEvent; return () => {}; } }));
vi.mock('@/lib/local-cache/cache', () => ({ isCachedResult: () => false, isExplicitAccessError: () => false }));
vi.mock('@/lib/local-cache/read-freshness', () => ({ isReadAccessPending: () => false }));
vi.mock('@/lib/local-cache/use-read-model-updates', () => ({ useReadModelUpdates: (load: () => void) => { f.refresh = load as () => Promise<void>; return { scheduleRefresh: load, refreshFromServer: load }; } }));
vi.mock('@/lib/connectivity/use-online-recovery', () => ({ useOnlineRecovery: () => {} }));
vi.mock('@/components/ui/theme-provider', () => ({ useTheme: () => ({ colors: {} }) }));
vi.mock('@/components/ui/screen', () => ({ Screen: 'Screen' }));
vi.mock('@/components/ui/page-header', () => ({ PageHeader: 'PageHeader' }));
vi.mock('@/components/ui/text', () => ({ ThemedText: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/badge', () => ({ Badge: 'Badge' }));
vi.mock('@/components/ui/card', () => ({ Card: 'Card' }));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: 'Textarea' }));
vi.mock('@/components/ui/progress', () => ({ Progress: 'Progress' }));
vi.mock('@/components/ui/task-status', () => ({ TaskStatus: 'TaskStatus' }));
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: 'ConfirmDialog' }));
vi.mock('@/components/ui/modal-layer', () => ({ ModalLayer: 'ModalLayer' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/deadline-status', () => ({ DeadlineCard: 'DeadlineCard', DeadlineBadge: 'DeadlineBadge', OverdueBadge: 'OverdueBadge' }));
vi.mock('@/components/ui/realtime-indicator', () => ({ RealtimeIndicator: 'RealtimeIndicator' }));
vi.mock('@/components/ui/states', () => ({ LoadingState: 'LoadingState', ErrorState: 'ErrorState', EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/error-message', () => ({ ErrorMessage: 'ErrorMessage' }));

let screen: ReactTestRenderer;
let remote: { id: string; name: string; description: string; role: string; status: string };
const input = () => screen.root.findAllByType('Input' as never).find((node) => node.props.label === 'Название проекта')!;
const description = () => screen.root.findByType('Textarea' as never);
const button = (label: string) => screen.root.findAllByType('Button' as never).find((node) => node.props.children === label)!;
async function mount() { await act(async () => { screen = create(createElement(ProjectScreen)); }); }
async function edit() { await act(async () => button('Редактировать').props.onPress()); }
async function refresh() { await act(async () => { await f.refresh!(); }); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  f.id = 'project'; remote = { id: f.id, name: 'Project', description: 'Description', role: 'owner', status: 'active' };
  f.get.mockReset(); f.get.mockImplementation(async () => ({ ...remote }));
  f.save.mockReset(); f.save.mockResolvedValue(undefined);
});
afterEach(async () => { await act(async () => screen?.unmount()); });
it('B01: Realtime preserves dirty input and requires explicit resolution of a concurrent field edit', async () => {
  await mount(); await edit();
  await act(async () => input().props.onChangeText('My draft'));
  remote.name = 'Other participant';
  await act(async () => { f.event!(); });
  expect(input().props.value).toBe('My draft');
  expect(button('Сохранить').props.disabled).toBe(true);
  await act(async () => button('Продолжить с моим черновиком').props.onPress());
  await act(async () => button('Сохранить').props.onPress());
  expect(f.save).toHaveBeenCalledWith('project','My draft','Description',{ name: 'Other participant', description: 'Description' });
  expect(screen.root.findAllByType('Input' as never)).toHaveLength(0);
});
it('B01: pristine refresh rebases; failed save preserves input; cancel and reopen use current server values', async () => {
  await mount(); await edit(); remote.name = 'Fresh'; await refresh();
  expect(input().props.value).toBe('Fresh');
  await act(async () => description().props.onChangeText('Unsaved'));
  f.save.mockRejectedValueOnce(new Error('Server unavailable'));
  await act(async () => button('Сохранить').props.onPress());
  expect(description().props.value).toBe('Unsaved');
  await act(async () => button('Отмена').props.onPress());
  await edit(); expect(description().props.value).toBe('Description');
  expect(input().props.value).toBe('Fresh');
});
it('B01: late responses and rapid updates cannot replace a newer snapshot or a dirty draft', async () => {
  await mount(); await edit();
  await act(async () => input().props.onChangeText('Draft'));
  let release!: (row: unknown) => void;
  f.get.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  let first!: Promise<void>;
  await act(async () => { first = f.refresh!(); });
  remote.name = 'Newest'; await refresh();
  await act(async () => { release({ ...remote, name: 'Stale' }); await first; });
  expect(input().props.value).toBe('Draft');
  await act(async () => button('Отмена').props.onPress()); await edit();
  expect(input().props.value).toBe('Newest');
});
it('B01: changing project or leaving editing discards only the old project draft', async () => {
  await mount(); await edit();
  await act(async () => input().props.onChangeText('Old project draft'));
  f.id = 'other'; remote = { ...remote, id: 'other', name: 'Other project' };
  await act(async () => screen.update(createElement(ProjectScreen)));
  await edit(); expect(input().props.value).toBe('Other project');
});
it('B01: a stale save rejected by SQL triggers refresh without losing the draft', async () => {
  await mount(); await edit();
  await act(async () => input().props.onChangeText('Local'));
  remote.name = 'Concurrent'; f.save.mockRejectedValueOnce({ code: 'PT409', message: 'Changed' });
  await act(async () => button('Сохранить').props.onPress());
  expect(input().props.value).toBe('Local'); expect(button('Сохранить').props.disabled).toBe(true);
});

