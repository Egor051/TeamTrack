import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { ClockFace } from '@/components/ui/clock-face.web';

let screen: ReactTestRenderer;
afterEach(async () => { await act(async () => screen?.unmount()); });
it.each(['mouse', 'touch', 'pen'])('captures %s across numbers, both rings and outside the face; cancel never confirms', async (pointerType) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const point = vi.fn(); const finish = vi.fn(); const captured = new Set<number>();
  const target = { focus: vi.fn(), getBoundingClientRect: () => ({ left: 100, top: 50, width: 252, height: 252 }),
    setPointerCapture: (id: number) => captured.add(id), hasPointerCapture: (id: number) => captured.has(id), releasePointerCapture: (id: number) => captured.delete(id) };
  const event = (clientX: number, clientY: number) => ({ currentTarget: target, target: { tagName: 'SPAN' }, clientX, clientY, isPrimary: true, button: 0, pointerId: 7, pointerType, preventDefault: vi.fn() });
  await act(async () => { screen = create(createElement(ClockFace, { children: 'Numbers', label: 'Часы', value: null, max: 23, busy: false, background: 'white', onPoint: point, onFinish: finish, onAdjust: vi.fn() })); });
  const face = screen.root.findByType('div');
  expect(face.props.style).toMatchObject({ userSelect: 'none', touchAction: 'none' });
  face.props.onPointerDown(event(226, 73)); expect(captured.has(7)).toBe(true);
  face.props.onPointerMove(event(291, 176)); expect(point).toHaveBeenLastCalledWith(191, 126);
  face.props.onPointerMove(event(500, 500)); expect(point).toHaveBeenLastCalledWith(400, 450);
  face.props.onPointerUp(event(226, 111)); expect(captured.size).toBe(0); expect(finish).toHaveBeenCalledOnce();
  face.props.onPointerDown(event(226, 73)); face.props.onPointerCancel(event(226, 73));
  face.props.onPointerUp(event(226, 73)); expect(finish).toHaveBeenCalledOnce();
});
