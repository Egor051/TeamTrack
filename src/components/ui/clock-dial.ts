export const FACE_SIZE = 252;
export const OUTER_RADIUS = 103;
export const INNER_RADIUS = 65;
export function dialValue(x: number, y: number, mode: 'hour' | 'minute'): number {
  const dx = x - FACE_SIZE / 2; const dy = FACE_SIZE / 2 - y;
  const turns = (Math.atan2(dx, dy) / (2 * Math.PI) + 1) % 1;
  if (mode === 'minute') return Math.round(turns * 60) % 60;
  const slot = Math.round(turns * 12) % 12;
  return Math.hypot(dx, dy) < (OUTER_RADIUS + INNER_RADIUS) / 2 ? slot || 12 : slot === 0 ? 0 : slot + 12;
}
