import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ reduced: true, changed: () => {}, loop: vi.fn(), start: vi.fn(), stop: vi.fn(), remove: vi.fn() }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', Pressable: 'Pressable', StyleSheet: { create: (v: unknown) => v },
  Animated: { View: 'AnimatedView', Value: class { setValue = vi.fn(); }, timing: vi.fn(), sequence: vi.fn(), loop: f.loop },
  Easing: { ease: vi.fn(), inOut: vi.fn() } }));
vi.mock('@/components/ui/theme-provider', () => ({ useTheme: () => ({ colors: { destructive: 'red' } }) }));
vi.mock('@/components/ui/text', () => ({ ThemedText: 'Text' }));
vi.mock('@/components/ui/badge', () => ({ Badge: 'Badge' }));
import { DeadlineCard } from '@/components/ui/deadline-status';
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.clearAllMocks(); f.reduced = true; f.loop.mockReturnValue({ start: f.start, stop: f.stop });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('window', { matchMedia: () => ({ get matches() { return f.reduced; }, addEventListener: (_: string, fn: () => void) => { f.changed = fn; }, removeEventListener: f.remove }) });
});
afterEach(async () => { await act(async () => renderer?.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('prefers-reduced-motion keeps a static red card and adds no animation loop', async () => {
  await act(async () => { renderer = create(createElement(DeadlineCard, { state: 'overdue', children: 'Stage' })); });
  expect(f.start).not.toHaveBeenCalled();
  expect(renderer.root.findAll((node) => node.type as unknown === 'AnimatedView')).toHaveLength(0);
});
it('a motion preference change starts a soft loop, and clearing overdue stops it', async () => {
  await act(async () => { renderer = create(createElement(DeadlineCard, { state: 'overdue', children: 'Stage' })); });
  await act(async () => { f.reduced = false; f.changed(); });
  expect(f.start).toHaveBeenCalledOnce();
  await act(async () => { renderer.update(createElement(DeadlineCard, { state: 'urgent', children: 'Stage' })); });
  expect(f.stop).toHaveBeenCalledOnce();
  expect(renderer.root.findAll((node) => node.type as unknown === 'AnimatedView')).toHaveLength(0);
});
