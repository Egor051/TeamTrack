import { expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';
const f = vi.hoisted(() => ({ version: 0, subscribe: vi.fn(), cleanup: vi.fn() }));
vi.mock('react-native', () => ({ View: () => null, StyleSheet: { create: (value: unknown) => value } }));
vi.mock('expo-router', async () => { const React = await import('react'); return { router: { replace: vi.fn() }, useLocalSearchParams: () => ({ id: 'project' }),
  useFocusEffect: (callback: () => void) => React.useEffect(callback, [callback]) }; });
vi.mock('@/features/auth/PermissionProvider', () => ({ usePermissionVersion: () => f.version }));
vi.mock('@/lib/connectivity/use-online-recovery', () => ({ useOnlineRecovery: () => undefined }));
vi.mock('@/lib/supabase/realtime', () => ({ subscribeMany: f.subscribe }));
vi.mock('@/features/projects/projects', () => ({ getProject: async () => ({ name: 'Project', status: 'active', role: 'owner' }), listProjectMembers: async () => [] }));
vi.mock('@/components/ui/screen', () => ({ Screen: () => null }));
vi.mock('@/components/ui/page-header', () => ({ PageHeader: () => null }));
vi.mock('@/components/ui/card', () => ({ Card: () => null }));
vi.mock('@/components/ui/badge', () => ({ Badge: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: () => null }));
vi.mock('@/components/ui/input', () => ({ Input: () => null }));
vi.mock('@/components/ui/select', () => ({ Select: () => null }));
vi.mock('@/components/ui/states', () => ({ EmptyState: () => null, ErrorState: () => null, LoadingState: () => null }));
vi.mock('@/components/ui/error-message', () => ({ ErrorMessage: () => null }));
vi.mock('@/components/ui/text', () => ({ ThemedText: () => null }));
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/components/ui/theme-provider', () => ({ useTheme: () => ({ colors: {} }) }));
import MembersScreen from '@/app/(app)/projects/[id]/members';

it('AUD-04: permission revalidation recreates the focused Members subscription', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  f.subscribe.mockImplementation(() => f.cleanup); f.version = 0;
  let screen!: ReturnType<typeof create>;
  await act(async () => { screen = create(createElement(MembersScreen)); });
  expect(f.subscribe).toHaveBeenCalledOnce();
  f.version = 1; // PermissionProvider has already closed the old resource channel.
  await act(async () => { screen.update(createElement(MembersScreen)); });
  expect(f.cleanup).toHaveBeenCalledOnce();
  expect(f.subscribe).toHaveBeenCalledTimes(2);
  await act(async () => { screen.unmount(); });
});
