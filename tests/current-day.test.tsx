import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ state: (_state: string) => {} }));
vi.mock('react-native', () => ({ AppState: { addEventListener: (_name: string, callback: typeof f.state) => { f.state = callback; return { remove() {} }; } } }));
import { useCurrentDay } from '@/lib/local-cache/use-current-day';
let day: string, screen: ReactTestRenderer;
function Reader() { day = useCurrentDay(); return null; }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-20T20:59:59Z')); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(async () => { await act(async () => screen?.unmount()); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('BUG-12 changes the day exactly at midnight UTC+3 without a network or model event', async () => {
  await act(async () => { screen = create(createElement(Reader)); }); expect(day).toBe('2026-10-19T21:00:00.000Z');
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); expect(day).toBe('2026-10-20T21:00:00.000Z');
});
it('rechecks the date after suspended native timers or a wall-clock change', async () => {
  await act(async () => { screen = create(createElement(Reader)); });
  vi.setSystemTime(new Date('2026-10-22T05:00:00Z'));
  await act(async () => f.state('active')); expect(day).toBe('2026-10-21T21:00:00.000Z');
});
