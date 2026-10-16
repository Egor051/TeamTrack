import { useRef, type PointerEvent } from 'react';
import type { ClockFaceProps } from './clock-face';
import { FACE_SIZE } from './clock-dial';
export function ClockFace({ children, label, value, max, busy, background, onPoint, onFinish, onAdjust }: ClockFaceProps) {
  const pointer = useRef<number | null>(null);
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    onPoint((event.clientX - rect.left) * FACE_SIZE / rect.width, (event.clientY - rect.top) * FACE_SIZE / rect.height);
  };
  return <div role="slider" tabIndex={busy ? -1 : 0} aria-label={label} aria-disabled={busy} aria-valuemin={0} aria-valuemax={max}
    aria-valuenow={value ?? undefined} aria-valuetext={value === null ? 'Не выбрано' : String(value)}
    style={{ position: 'relative', width: FACE_SIZE, height: FACE_SIZE, borderRadius: FACE_SIZE / 2, background, userSelect: 'none', WebkitUserSelect: 'none', touchAction: 'none', flexShrink: 0 }}
    onPointerDown={(event) => {
      if (busy || !event.isPrimary || event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus(); pointer.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId); point(event);
    }}
    onPointerMove={(event) => { if (!busy && pointer.current === event.pointerId) { event.preventDefault(); point(event); } }}
    onPointerUp={(event) => {
      if (pointer.current !== event.pointerId) return;
      pointer.current = null;
      if (!busy) point(event);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (!busy) onFinish();
    }}
    onPointerCancel={() => { pointer.current = null; }} onLostPointerCapture={() => { pointer.current = null; }}
    onKeyDown={(event) => {
      if (busy) return;
      if (['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'].includes(event.key)) { event.preventDefault(); onAdjust(['ArrowUp', 'ArrowRight'].includes(event.key) ? 1 : -1); }
      if (event.key === 'Enter') { event.preventDefault(); onFinish(); }
    }}>{children}</div>;
}
