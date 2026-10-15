import { useState } from 'react';
import { Pressable, type LayoutChangeEvent, type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import { radii, shadows, spacing } from '@/components/ui/theme';
import { useTheme } from './theme-provider';

export function Card({ children, onPress, onLayout, style, accessibilityLabel, muted, tone }: { children: React.ReactNode; onPress?: () => void; onLayout?: (event: LayoutChangeEvent) => void; style?: StyleProp<ViewStyle>; accessibilityLabel?: string; muted?: boolean; tone?: 'warning' | 'destructive' }) {
  const { colors: theme } = useTheme();
  const [hovered, setHovered] = useState(false);
  const cardStyle = [styles.card, { backgroundColor: tone ? theme[`${tone}Soft`] : muted ? theme.surfaceMuted : theme.surface, borderColor: tone ? theme[tone] : theme.border }, muted && styles.muted, style];
  if (!onPress) return <View onLayout={onLayout} style={cardStyle}>{children}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)} style={({ pressed }) => [cardStyle, hovered && !tone && { borderColor: theme.primary, backgroundColor: theme.primarySoft }, pressed && styles.pressed]}>{children}</Pressable>;
}
const styles = StyleSheet.create({ card: { borderRadius: radii.md, borderWidth: 1, padding: spacing.lg, gap: spacing.md, minWidth: 0, ...shadows.card }, muted: { shadowOpacity: 0, elevation: 0 }, pressed: { opacity: 0.8 } });
