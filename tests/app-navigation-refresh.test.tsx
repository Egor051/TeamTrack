import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerOfflineWork } from '@/lib/local-cache/work-requests';
import { AppNavigation } from '@/features/notifications/app-navigation';
import { useReadModelUpdates } from '@/lib/local-cache/use-read-model-updates';

const f = vi.hoisted(() => ({ path: '/templates', user: 'a', focused: true, load: vi.fn(), work: vi.fn(), invalidate: vi.fn(), unread: vi.fn() }));
vi.mock('expo-router', () => ({ Link: 'Link', usePathname: () => f.path,
  useFocusEffect: (callback: () => void | (() => void)) => useEffect(() => f.focused ? callback() : undefined, [callback, f.focused]) }));
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (value: unknown) => value } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@/features/auth/AuthProvider', () => ({ useUser: () => ({ id: f.user }) }));
vi.mock('@/components/ui/theme-provider', () => ({ useTheme: () => ({ colors: { text: 'white', borderStrong: 'gray' } }) }));
vi.mock('@/components/ui/text', () => ({ ThemedText: 'Text' }));
vi.mock('@/components/ui/error-message', () => ({ ErrorMessage: 'ErrorMessage' }));
vi.mock('@/features/notifications/notifications', () => ({ fetchUnreadCount: f.unread, subscribeToNotifications: () => () => undefined }));
vi.mock('@/features/projects/checklist-overview', () => ({ listChecklistOverview: async () => [] }));
vi.mock('@/features/projects/use-deadline-clock', () => ({ useDeadlineClock: () => Date.now() }));
vi.mock('@/lib/supabase/realtime', () => ({ subscribeTable: () => () => undefined }));
vi.mock('@/lib/local-cache/cache', () => ({ activeCacheUserId: async () => f.user, isExplicitAccessError: () => false }));
vi.mock('@/lib/local-cache/read-freshness', () => ({ invalidateReadModels: f.invalidate, isReadAccessPending: () => false, scopeReadPrefixes: async () => ['templates', 'template-items:'] }));

function Page() { useReadModelUpdates(f.load, { view: 'templates' }); return null; }
function Harness() { return createElement('App', null, createElement(AppNavigation), createElement(Page)); }
let renderer: ReactTestRenderer;
let unregister: () => void;
const buttons = () => renderer.root.findAllByType('Pressable' as never);
const refresh = () => buttons().find((button) => button.props.accessibilityLabel === 'Обновить')!;
const body = () => JSON.stringify(renderer.toJSON());
async function mount() { await act(async () => { renderer = create(createElement(Harness)); }); }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.clearAllMocks(); f.path = '/templates'; f.user = 'a'; f.focused = true;
  f.load.mockResolvedValue(undefined); f.invalidate.mockResolvedValue(undefined); f.unread.mockResolvedValue(0);
  f.work.mockResolvedValue({ outcome: 'success', error: null });
  unregister = registerOfflineWork('a', f.work);
});
afterEach(async () => { await act(async () => { renderer?.unmount(); }); unregister(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('navigation Refresh', () => {
  it.each(['/projects/one', '/projects/one/members', '/projects/one/progress', '/projects/one/tasks/two', '/projects/one/tasks/two/history', '/projects/one/tasks/two/progress', '/notifications', '/templates', '/profile', '/projects/new', '/projects/one/tasks/new'])(
    'shows one icon before the existing navigation links on %s', async (path) => {
      f.path = path; await mount();
      expect(buttons().map((button) => button.props.accessibilityLabel ?? button.props.children.at(-1).props.children)).toEqual(['Обновить', 'Уведомления', 'Шаблоны', 'Профиль']);
      expect(body()).toContain('↻');
      expect(renderer.root.findAllByProps({ children: 'Обновить' })).toHaveLength(0);
      await act(async () => { refresh().props.onHoverIn({}); });
      expect(renderer.root.findAllByProps({ children: 'Обновить' })).toHaveLength(1);
    });

  it('leaves the main navigation with exactly its original three links', async () => {
    f.path = '/projects'; await mount();
    expect(refresh()).toBeUndefined(); expect(buttons()).toHaveLength(3);
    expect(renderer.root.findAllByType('Link' as never).map((link) => link.props.href)).toEqual(['/notifications', '/templates', '/profile']);
    expect(f.work).not.toHaveBeenCalled(); expect(f.load).not.toHaveBeenCalled();
  });

  it('joins repeat presses, waits for existing work, refreshes the current read scope and shows progress', async () => {
    let release!: () => void;
    f.work.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await mount();
    await act(async () => { refresh().props.onPress(); refresh().props.onPress(); });
    expect(f.work).toHaveBeenCalledExactlyOnceWith('manual-refresh'); expect(f.load).not.toHaveBeenCalled();
    expect(refresh().props.disabled).toBe(true); expect(refresh().props.accessibilityState.busy).toBe(true);
    expect(renderer.root.findAllByType('ActivityIndicator' as never)).toHaveLength(1);
    await act(async () => { release(); });
    expect(f.invalidate).toHaveBeenCalledWith('a', ['templates', 'template-items:'], 'refresh');
    expect(f.invalidate).toHaveBeenCalledWith('a', ['notifications:unread-count', 'checklist-overview'], 'refresh');
    expect(f.load).toHaveBeenCalledOnce(); expect(f.unread).toHaveBeenCalled(); expect(refresh().props.disabled).toBe(false);
    expect(f.path).toBe('/templates');
  });

  it('shows an error and permits a successful retry without navigation', async () => {
    f.load.mockRejectedValueOnce(new Error('Read failed'));
    await mount(); await act(async () => { refresh().props.onPress(); });
    expect(renderer.root.findAllByType('ErrorMessage' as never)).toHaveLength(1); expect(refresh().props.disabled).toBe(false);
    await act(async () => { refresh().props.onPress(); });
    expect(f.load).toHaveBeenCalledTimes(2); expect(renderer.root.findAllByType('ErrorMessage' as never)).toHaveLength(0);
  });

  it('retains coordinator error feedback even if the cache-backed screen read succeeds', async () => {
    f.work.mockResolvedValue({ outcome: 'waiting-network', error: 'Сеть недоступна' });
    await mount(); await act(async () => { refresh().props.onPress(); });
    expect(f.load).toHaveBeenCalledOnce(); expect(body()).toContain('Сеть недоступна'); expect(refresh().props.disabled).toBe(false);
  });

  it('reports a navigation read failure and resets the busy state', async () => {
    await mount(); f.unread.mockRejectedValueOnce(new Error('Unread count failed'));
    await act(async () => { refresh().props.onPress(); });
    expect(renderer.root.findAllByType('ErrorMessage' as never)).toHaveLength(1); expect(refresh().props.disabled).toBe(false);
  });

  it.each(['route', 'account', 'blur'])('fences pending refresh after %s changes', async (change) => {
    let release!: () => void;
    f.work.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    await mount(); await act(async () => { refresh().props.onPress(); });
    if (change === 'route') f.path = '/profile';
    if (change === 'account') f.user = 'b';
    if (change === 'blur') f.focused = false;
    await act(async () => { renderer.update(createElement(Harness)); });
    await act(async () => { release(); });
    expect(f.load).not.toHaveBeenCalled(); expect(refresh().props.disabled).toBe(false);
  });
});
