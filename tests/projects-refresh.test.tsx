import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { announceReadModelCommit } from '@/lib/local-cache/read-model-events';
import { registerOfflineWork } from '@/lib/local-cache/work-requests';

const f = vi.hoisted(() => ({ user: 'a', projects: vi.fn(), tasks: vi.fn(), get: vi.fn(), work: vi.fn(), cached: new Map<string, unknown>() }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() }, Link: 'Link', useFocusEffect: (callback: () => void | (() => void)) => useEffect(callback, [callback]) }));
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', RefreshControl: 'RefreshControl', StyleSheet: { create: (value: unknown) => value }, useWindowDimensions: () => ({ width: 1200 }) }));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ state: { user: { id: f.user }, profile: {} } }) }));
vi.mock('@/features/auth/PermissionProvider', () => ({ usePermissionVersion: () => 0 }));
vi.mock('@/features/projects/projects', () => ({ listProjects: f.projects, listMyTasks: f.tasks }));
vi.mock('@/features/notifications/notifications', () => ({ fetchUnreadCount: async () => 0, subscribeToNotifications: () => () => undefined }));
vi.mock('@/lib/supabase/realtime', () => ({ subscribeTable: () => () => undefined }));
vi.mock('@/lib/local-cache/cache', () => ({ activeCacheUserId: async () => f.user, getCached: f.get,
  filterBlockedProjects: async (_: string, value: unknown) => value, filterBlockedTasks: async (_: string, value: unknown) => value,
  isCachedResult: () => false, isTransportFailure: () => false, isExplicitAccessError: () => false }));
vi.mock('@/components/ui/theme-provider', () => ({ useTheme: () => ({ colors: {} }) }));
vi.mock('@/components/ui/screen', () => ({ Screen: 'Screen' }));
vi.mock('@/components/ui/text', () => ({ ThemedText: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/badge', () => ({ Badge: 'Badge' }));
vi.mock('@/components/ui/card', () => ({ Card: 'Card' }));
vi.mock('@/components/ui/states', () => ({ EmptyState: 'EmptyState', ErrorState: 'ErrorState', LoadingState: 'LoadingState' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/error-message', () => ({ ErrorMessage: 'ErrorMessage' }));
vi.mock('@/components/ui/realtime-indicator', () => ({ RealtimeIndicator: 'RealtimeIndicator' }));
vi.mock('@/components/ui/offline-ready-indicator', () => ({ OfflineReadyIndicator: 'OfflineReadyIndicator' }));
import ProjectsScreen from '@/app/(app)/projects';

let renderer: ReactTestRenderer;
let unregister: () => void;
const rows = (name: string) => [{ id: name, name, role: 'owner', status: 'active', created_at: '2026-10-05T00:00:00Z' }];
const body = () => JSON.stringify(renderer.toJSON(), (key, value) => key === '_owner' ? undefined : value);
const button = () => renderer.root.findByProps({ children: 'Обновить' });
beforeEach(() => {
  vi.clearAllMocks(); f.user = 'a'; f.cached.clear();
  f.projects.mockResolvedValue(rows('Initial')); f.tasks.mockResolvedValue([]);
  f.get.mockImplementation(async (_user: string, key: string) => f.cached.get(key) ?? null);
  f.work.mockResolvedValue({ outcome: 'success', sync: null, preparation: 'skipped', error: null });
  unregister = registerOfflineWork('a', f.work);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => { await act(async () => { renderer?.unmount(); }); unregister(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount() { await act(async () => { renderer = create(createElement(ProjectsScreen)); }); }
describe('/projects Refresh', () => {
  it('uses manual-refresh, coalesces repeated presses and leaves the displayed data usable', async () => {
    await mount(); let release!: () => void;
    f.work.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await act(async () => { button().props.onPress(); button().props.onPress(); });
    expect(f.work).toHaveBeenCalledOnce(); expect(f.work).toHaveBeenCalledWith('manual-refresh');
    expect(button().props.loading).toBe(true); expect(body()).toContain('Initial');
    await act(async () => { release(); });
    expect(f.projects).toHaveBeenCalledTimes(2); expect(button().props.loading).toBe(false);
    expect(body()).not.toContain('Повторить');
    expect(renderer.root.findAllByProps({ children: 'Обновить' })).toHaveLength(1);
  });
  it('an atomic preload commit supersedes a late page response and updates React without another HTTP fetch', async () => {
    let release!: (value: unknown) => void;
    f.projects.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await mount(); f.cached.set('projects:active', rows('Committed newer')); f.cached.set('my-tasks:a', []);
    await act(async () => { announceReadModelCommit('a', ['projects:active', 'my-tasks:a'], 'preparation'); });
    expect(body()).toContain('Committed newer');
    await act(async () => { release(rows('Late old')); });
    expect(body()).toContain('Committed newer'); expect(body()).not.toContain('Late old'); expect(f.projects).toHaveBeenCalledOnce();
  });
  it('a foreign account commit and a late refresh cannot display old-account data', async () => {
    await mount(); let release!: () => void;
    f.work.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await act(async () => { button().props.onPress(); });
    f.user = 'b'; f.projects.mockResolvedValue(rows('Account B'));
    await act(async () => { renderer.update(createElement(ProjectsScreen)); });
    await act(async () => { announceReadModelCommit('a', ['projects:active'], 'preparation'); release(); });
    expect(body()).toContain('Account B'); expect(body()).not.toContain('Initial');
  });
});
