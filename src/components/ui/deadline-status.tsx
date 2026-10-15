import { useEffect, useState, type ComponentProps } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View } from 'react-native';
import { Card } from './card';
import { Badge } from './badge';
import { ThemedText } from './text';
import { useTheme } from './theme-provider';
import { russianCount } from '@/lib/russian';
import { deadlineState, formatDeadline, type DeadlineItem, type DeadlineState } from '@/features/projects/deadlines';

export function DeadlineIndicators({ urgent, overdue }: { urgent: number; overdue: number }) {
  const { colors } = useTheme();
  return <View style={styles.indicators} accessibilityLiveRegion="polite">
    {overdue > 0 ? <ThemedText type="small" style={{ color: colors.destructive, fontWeight: '600' }}>{russianCount(overdue, ['просроченный дедлайн', 'просроченных дедлайна', 'просроченных дедлайнов'])}</ThemedText> : null}
    {urgent > 0 ? <ThemedText type="small" style={{ color: colors.warning, fontWeight: '600' }}>{russianCount(urgent, ['горящий дедлайн', 'горящих дедлайна', 'горящих дедлайнов'])}</ThemedText> : null}
  </View>;
}

export function OverdueBadge({ overdue }: { overdue: number }) {
  return overdue > 0 ? <Badge tone="danger">Просрочен дедлайн</Badge> : null;
}

export function ChecklistDeadline({ item, now }: { item: DeadlineItem; now: number }) {
  const state = deadlineState(item, now);
  return item.deadline_at ? <View style={styles.indicators}>
    <ThemedText type="small">Дедлайн: {formatDeadline(item.deadline_at)}</ThemedText>
    {state !== 'normal' ? <Badge tone={state === 'overdue' ? 'danger' : 'warning'}>{state === 'overdue' ? 'Просрочен дедлайн' : 'Горящий дедлайн'}</Badge> : null}
  </View> : null;
}

export function DeadlineCard({ state, children, ...props }: ComponentProps<typeof Card> & { state: DeadlineState }) {
  const { colors } = useTheme();
  const [opacity] = useState(() => new Animated.Value(0));
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    let active = true;
    if (Platform.OS === 'web') {
      const query = window.matchMedia('(prefers-reduced-motion: reduce)');
      const update = () => setReduced(query.matches);
      update(); query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
    }
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) setReduced(value); }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => { active = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    opacity.setValue(0);
    if (state !== 'overdue' || reduced) return;
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 0.12, duration: 1600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    animation.start();
    return () => { animation.stop(); opacity.setValue(0); };
  }, [opacity, reduced, state]);
  return <Card {...props} tone={state === 'overdue' ? 'destructive' : state === 'urgent' ? 'warning' : undefined}>
    {state === 'overdue' && !reduced ? <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.fill, styles.tint, { backgroundColor: colors.destructive, opacity }]} /> : null}
    {children}
  </Card>;
}

const styles = StyleSheet.create({
  indicators: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, maxWidth: '100%', minWidth: 0, flexShrink: 1 },
  tint: { borderRadius: 8 }, fill: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
});
