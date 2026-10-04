import { createElement, type ComponentType } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialBootstrap, type BootstrapMetadata } from '@/lib/local-cache/bootstrap-types';

const f = vi.hoisted(() => ({ meta: null as BootstrapMetadata | null, select: vi.fn(), retry: vi.fn(), platform: { OS: 'web' } }));
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable', ScrollView: 'ScrollView', RefreshControl: 'RefreshControl',
  Platform: f.platform, StyleSheet: { create: (x: unknown) => x }, useWindowDimensions: () => ({ width: 1200 }) }));
vi.mock('expo-router', () => ({ router: { push: vi.fn(), replace: vi.fn() }, Link: 'Link', useFocusEffect: vi.fn() }));
vi.mock('@/features/auth/AuthProvider', () => ({ useAuth: () => ({ state: { user: { id: 'user-a', email: 'a@test.local' }, profile: { display_name: 'User A' } } }) }));
vi.mock('@/lib/local-cache/use-offline-bootstrap', () => ({ useOfflineBootstrap: () => f.meta }));
vi.mock('@/lib/local-cache/bootstrap', () => ({ selectOfflineScheme: f.select, retryAccountBootstrap: f.retry }));
vi.mock('@/lib/local-cache/cache', () => ({ isCachedResult: () => false, isExplicitAccessError: () => false, isTransportFailure: () => false }));
vi.mock('@/features/projects/projects', () => ({ listOwnedProjects: vi.fn(async () => []), listProjectMembers: vi.fn(), listProjects: vi.fn(), listMyTasks: vi.fn(), transferProjectOwnership: vi.fn() }));
vi.mock('@/features/auth/PermissionProvider', () => ({ usePermissionVersion: () => 0 }));
vi.mock('@/lib/supabase/realtime', () => ({ subscribeTable: vi.fn() }));
vi.mock('@/features/notifications/notifications', () => ({ fetchUnreadCount: vi.fn(), subscribeToNotifications: vi.fn() }));
vi.mock('@/components/ui/theme-provider', () => ({ useTheme: () => ({ mode: 'system', setMode: vi.fn(), colors: { success: 'green', warning: 'yellow', destructive: 'red', primary: 'blue', border: 'gray' } }) }));
vi.mock('@/components/ui/screen', () => ({ Screen: 'Screen' }));
vi.mock('@/components/ui/page-header', () => ({ PageHeader: 'PageHeader' }));
vi.mock('@/components/ui/text', () => ({ ThemedText: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/card', () => ({ Card: 'Card' }));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: 'ConfirmDialog' }));
vi.mock('@/components/ui/error-message', () => ({ ErrorMessage: 'ErrorMessage' }));
vi.mock('@/components/ui/badge', () => ({ Badge: 'Badge' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/states', () => ({ EmptyState: 'EmptyState', LoadingState: 'LoadingState', ErrorState: 'ErrorState' }));
vi.mock('@/components/ui/realtime-indicator', () => ({ RealtimeIndicator: () => createElement('SyncIndicator', {}, 'Синхронизация: актуально') }));

import ProfileScreen, { OfflinePreferences } from '@/app/(app)/profile';
import ProjectsScreen from '@/app/(app)/projects';
import { OfflineReadyIndicator, offlineReadyLabel } from '@/components/ui/offline-ready-indicator';
const renderers: ReactTestRenderer[] = [];
async function render(component: ComponentType) { let r!: ReactTestRenderer; await act(async () => { r = create(createElement(component)); }); renderers.push(r); return r; }
const body = (r: ReactTestRenderer) => JSON.stringify(r.toJSON(), (key, value) => key === '_owner' ? undefined : value);
beforeEach(() => {
  f.meta = initialBootstrap('user-a'); f.platform.OS = 'web'; f.select.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => { await act(async () => { renderers.splice(0).forEach((r) => r.unmount()); }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('offline UX', () => {
  it('Retry invokes a new attempt and remains available while the old attempt is running', async () => {
    f.meta = { ...initialBootstrap('user-a'), status: 'running', progress: 94 };
    f.retry.mockResolvedValue('settled');
    const r = await render(OfflineReadyIndicator);
    await act(async () => { r.root.findByProps({ size: 'sm', variant: 'ghost' }).props.onPress(); });
    expect(f.retry).toHaveBeenCalledWith('user-a');
    expect(offlineReadyLabel({ ...f.meta, status: 'offline_waiting' })).toBe('Офлайн: ожидание сети');
    expect(offlineReadyLabel({ ...f.meta, status: 'ready', scheme: 'extended', offline_ready: true, basic_ready: true, extended_ready: false }))
      .toBe('Офлайн: базовые данные готовы');
  });
  it('renders the profile section below appearance with Basic selected by default', async () => {
    const r = await render(ProfileScreen);
    expect(body(r).indexOf('Оформление')).toBeLessThan(body(r).indexOf('Офлайн-режим'));
    expect(body(r).indexOf('Офлайн-режим')).toBeLessThan(body(r).indexOf('Передача владения'));
    const radios = r.root.findAllByProps({ accessibilityRole: 'radio' });
    expect(radios[0].props.accessibilityState.checked).toBe(true);
    expect(radios[1].props.accessibilityState.checked).toBe(false);
    expect(body(r)).not.toContain('Офлайн:');
  });
  it('saves the user-scoped choice and renders the persisted extended selection', async () => {
    const r = await render(OfflinePreferences);
    f.select.mockImplementation(async (user: string, scheme: 'extended') => { f.meta = { ...f.meta!, scheme, user_id: user }; });
    await act(async () => { await r.root.findAllByProps({ accessibilityRole: 'radio' })[1].props.onPress(); });
    expect(f.select).toHaveBeenCalledWith('user-a', 'extended');
    await act(async () => { r.update(createElement(OfflinePreferences)); });
    expect(r.root.findAllByProps({ accessibilityRole: 'radio' })[1].props.accessibilityState.checked).toBe(true);
  });
  it('shows independent sync and readiness indicators on projects and no readiness component elsewhere', async () => {
    f.meta = { ...initialBootstrap('user-a'), status: 'ready', offline_ready: true };
    const r = await render(ProjectsScreen);
    expect(body(r)).toContain('Синхронизация: актуально'); expect(body(r)).toContain('Офлайн: готово');
    for (const file of ['profile.tsx', 'templates.tsx', 'notifications.tsx', 'projects/[id].tsx', 'projects/[id]/members.tsx',
      'projects/[id]/tasks/[taskId].tsx', 'projects/[id]/progress.tsx', 'projects/[id]/tasks/[taskId]/progress.tsx', 'projects/[id]/tasks/[taskId]/history.tsx'])
      expect(readFileSync(new URL(`../src/app/(app)/${file}`, import.meta.url), 'utf8')).not.toContain('OfflineReadyIndicator');
  });
  it('displays deterministic progress/partial/error states and hides the web control on native', async () => {
    expect(offlineReadyLabel({ ...f.meta!, status: 'running', progress: 42 })).toBe('Офлайн: подготовка 42%');
    expect(offlineReadyLabel({ ...f.meta!, status: 'updating', progress: 63 })).toBe('Офлайн: обновление 63%');
    expect(offlineReadyLabel({ ...f.meta!, status: 'partial' })).toBe('Офлайн: частично готово');
    expect(offlineReadyLabel({ ...f.meta!, status: 'error' })).toBe('Офлайн: ошибка');
    f.platform.OS = 'android'; const r = await render(OfflineReadyIndicator); expect(r.toJSON()).toBeNull();
  });
});
