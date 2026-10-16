import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ active: (_state: string) => {}, remove: vi.fn() }));
vi.mock('react-native', () => ({ AppState: { addEventListener: (_event: string, callback: typeof f.active) => { f.active = callback; return { remove: f.remove }; } },
  Platform: { OS: 'ios' }, Modal: 'Modal', Pressable: 'Pressable', View: 'View', ScrollView: 'ScrollView', StyleSheet: { create: (v: unknown) => v } }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ ThemedText: 'Text' }));
vi.mock('@/components/ui/segmented-control', () => ({ SegmentedControl: 'SegmentedControl' }));
vi.mock('@/components/ui/theme-provider', () => ({ useTheme: () => ({ colors: { primary: 'green', destructive: 'red' } }) }));
import { DeadlinePicker, dialValue } from '@/components/ui/deadline-picker';
import { deadlineSummary, type DeadlineItem } from '@/features/projects/deadlines';
import { useDeadlineClock } from '@/features/projects/use-deadline-clock';

let renderer: ReactTestRenderer;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 15, 12, 0)); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(async () => { await act(async () => renderer?.unmount()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const text = () => JSON.stringify(renderer.toJSON());
const button = (label: string) => renderer.root.findByProps({ children: label });
async function mountPicker(save = vi.fn(async (_value: string): Promise<void> => undefined)) {
  await act(async () => { renderer = create(createElement(DeadlinePicker, { value: null, busy: false, onCancel: vi.fn(), onSave: save })); });
  return save;
}

describe('calendar and analog clock', () => {
  it('maps both rings of the 24-hour dial and exact minutes', () => {
    expect(dialValue(126, 0, 'hour')).toBe(0); expect(dialValue(252, 126, 'hour')).toBe(15);
    expect(dialValue(126, 252, 'hour')).toBe(18); expect(dialValue(0, 126, 'hour')).toBe(21);
    expect(dialValue(126, 61, 'hour')).toBe(12); expect(dialValue(191, 126, 'hour')).toBe(3);
    expect(dialValue(252, 126, 'minute')).toBe(15); expect(dialValue(126, 0, 'minute')).toBe(0);
  });
  it('selects date → 24-hour clock → minutes and confirms an absolute timestamp', async () => {
    const save = await mountPicker();
    const day = renderer.root.findAll((node) => node.type as unknown === 'Pressable').find((node) => node.props.accessibilityLabel.includes('20 октября'))!;
    await act(async () => day.props.onPress());
    expect(text()).toContain('Выберите часы');
    let face = renderer.root.findByProps({ accessibilityRole: 'adjustable' });
    await act(async () => { face.props.onResponderGrant({ nativeEvent: { locationX: 126, locationY: 61 } }); face.props.onResponderRelease(); });
    expect(text()).toContain('Выберите минуты');
    face = renderer.root.findByProps({ accessibilityRole: 'adjustable' });
    await act(async () => face.props.onResponderMove({ nativeEvent: { locationX: 252, locationY: 126 } }));
    await act(async () => button('Подтвердить').props.onPress());
    expect(save).toHaveBeenCalledOnce();
    const date = new Date(save.mock.calls[0][0]);
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()]).toEqual([2026, 9, 20, 12, 15]);
  });
  it('does not permit past dates or confirmation after the selected time has elapsed', async () => {
    const save = await mountPicker();
    const past = renderer.root.findAll((node) => node.type as unknown === 'Pressable').find((node) => node.props.accessibilityLabel.includes('14 октября'))!;
    expect(past.props.disabled).toBe(true);
    await act(async () => { renderer.update(createElement(DeadlinePicker, { key: 'edit', value: new Date(2026, 9, 16, 12, 30).toISOString(), busy: false, onCancel: vi.fn(), onSave: save })); });
    vi.setSystemTime(new Date(2026, 9, 20));
    await act(async () => button('Подтвердить').props.onPress());
    expect(save).not.toHaveBeenCalled(); expect(text()).toContain('в будущем');
  });
  it('opening a new value selects neither today, hours nor minutes; cancel saves nothing', async () => {
    const save = await mountPicker();
    const days = renderer.root.findAll((node) => node.type as unknown === 'Pressable');
    expect(days.some((day) => day.props.accessibilityState?.selected)).toBe(false);
    expect(button('Подтвердить').props.disabled).toBe(true);
    await act(async () => renderer.root.findByProps({ accessibilityLabel: 'Шаг выбора дедлайна' }).props.onChange('hour'));
    expect(renderer.root.findByProps({ accessibilityRole: 'adjustable' }).props.accessibilityValue.now).toBeUndefined();
    expect(text()).not.toContain('AM'); expect(text()).not.toContain('PM'); expect(save).not.toHaveBeenCalled();
  });
  it.each(Array.from({ length: 24 }, (_, hour) => hour))('selects hour %i on its proper ring', (hour) => {
    const slot = hour % 12; const radius = hour > 0 && hour <= 12 ? 65 : 103;
    expect(dialValue(126 + Math.sin(slot * Math.PI / 6) * radius, 126 - Math.cos(slot * Math.PI / 6) * radius, 'hour')).toBe(hour);
  });
  it.each(Array.from({ length: 60 }, (_, minute) => minute))('selects exact minute %i', (minute) => {
    expect(dialValue(126 + Math.sin(minute * Math.PI / 30) * 103, 126 - Math.cos(minute * Math.PI / 30) * 103, 'minute')).toBe(minute);
  });
});

describe('deadline visual clock', () => {
  function Clock({ items }: { items: DeadlineItem[] }) {
    const now = useDeadlineClock(items); return createElement('Counts', deadlineSummary(items, now));
  }
  it('crosses both time boundaries with no database event or server request and stops at 100%', async () => {
    const start = Date.now();
    const items = [{ deadline_at: new Date(start + 12 * 3_600_000 + 1000).toISOString(), percentage: 99 }];
    await act(async () => { renderer = create(createElement(Clock, { items })); });
    expect(renderer.root.find((node) => node.type as unknown === 'Counts').props.state).toBe('normal');
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(renderer.root.find((node) => node.type as unknown === 'Counts').props.urgent).toBe(1);
    await act(async () => { vi.advanceTimersByTime(12 * 3_600_000); });
    expect(renderer.root.find((node) => node.type as unknown === 'Counts').props.overdue).toBe(1);
    await act(async () => { renderer.update(createElement(Clock, { items: [{ ...items[0], percentage: 100 }] })); });
    expect(renderer.root.find((node) => node.type as unknown === 'Counts').props.state).toBe('normal'); expect(vi.getTimerCount()).toBe(0);
  });
  it('recalculates on foreground after a suspended device', async () => {
    const start = Date.now();
    await act(async () => { renderer = create(createElement(Clock, { items: [{ deadline_at: new Date(start + 1000).toISOString(), percentage: 0 }] })); });
    vi.setSystemTime(start + 5000);
    await act(async () => f.active('active'));
    expect(renderer.root.find((node) => node.type as unknown === 'Counts').props.overdue).toBe(1);
  });
});
