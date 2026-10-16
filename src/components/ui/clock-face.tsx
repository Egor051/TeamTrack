import type { ReactNode } from 'react';
import { View, type GestureResponderEvent } from 'react-native';
import { FACE_SIZE } from './clock-dial';
export type ClockFaceProps = { children: ReactNode; label: string; value: number | null; max: number; busy: boolean; background: string;
  onPoint: (x: number, y: number) => void; onFinish: () => void; onAdjust: (delta: number) => void };
export function ClockFace({ children, label, value, max, busy, background, onPoint, onFinish, onAdjust }: ClockFaceProps) {
  const point = (event: GestureResponderEvent) => { if (!busy) onPoint(event.nativeEvent.locationX, event.nativeEvent.locationY); };
  return <View style={{ width: FACE_SIZE, height: FACE_SIZE, borderRadius: FACE_SIZE / 2, backgroundColor: background }} accessible accessibilityRole="adjustable"
    accessibilityLabel={label} accessibilityState={{ disabled: busy }} accessibilityValue={{ min: 0, max, ...(value === null ? { text: 'Не выбрано' } : { now: value }) }}
    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]} onAccessibilityAction={(event) => { if (!busy) onAdjust(event.nativeEvent.actionName === 'increment' ? 1 : -1); }}
    onStartShouldSetResponder={() => !busy} onMoveShouldSetResponder={() => !busy} onResponderGrant={point} onResponderMove={point}
    onResponderRelease={() => { if (!busy) onFinish(); }} onResponderTerminationRequest={() => false}>{children}</View>;
}
