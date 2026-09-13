import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { ThemedText } from '@/components/ui/text';
import { radii } from '@/components/ui/theme';
import { useTheme } from './theme-provider';

type ButtonProps = {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  fullWidth?: boolean;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
} & Omit<PressableProps, 'style' | 'children'>;

export function Button({ variant = 'primary', size = 'md', disabled = false, loading = false, fullWidth = false, children, style, onHoverIn, onHoverOut, accessibilityState, accessibilityRole, ...rest }: ButtonProps) {
  const { colors: theme } = useTheme();
  const [hovered, setHovered] = useState(false);
  const unavailable = disabled || loading;
  const filled = variant === 'primary' || variant === 'destructive';
  const foreground = filled ? theme.surface : variant === 'ghost' ? theme.primary : theme.text;
  const background = variant === 'primary' ? theme.primary : variant === 'destructive' ? theme.destructive : variant === 'secondary' ? theme.surfaceMuted : 'transparent';
  return (
    <Pressable
      {...rest}
      disabled={unavailable}
      accessibilityRole={accessibilityRole ?? 'button'}
      accessibilityState={{ ...accessibilityState, disabled: unavailable, busy: loading }}
      onHoverIn={(event) => { setHovered(true); onHoverIn?.(event); }}
      onHoverOut={(event) => { setHovered(false); onHoverOut?.(event); }}
      style={({ pressed }) => [
        styles.container, sizes[size],
        { backgroundColor: background, borderColor: variant === 'outline' || variant === 'secondary' ? theme.borderStrong : 'transparent' },
        hovered && !unavailable && { backgroundColor: variant === 'primary' ? theme.primaryPressed : filled ? background : theme.primarySoft, borderColor: filled || variant === 'ghost' ? 'transparent' : theme.primary },
        fullWidth && styles.fullWidth, unavailable && !loading && styles.disabled, pressed && styles.pressed, style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={foreground} /> : null}
      <ThemedText type="small" style={[styles.text, { color: foreground }]}>{children}</ThemedText>
    </Pressable>
  );
}
const sizes = { sm: { minHeight: 44, paddingHorizontal: 12 }, md: { minHeight: 48, paddingHorizontal: 16 }, lg: { minHeight: 52, paddingHorizontal: 20 } };
const styles = StyleSheet.create({ container: { justifyContent: 'center', alignItems: 'center', borderRadius: radii.md, borderWidth: 1, flexDirection: 'row', gap: 8, paddingVertical: 9, maxWidth: '100%' }, text: { fontWeight: '600', textAlign: 'center', flexShrink: 1 }, disabled: { opacity: 0.45 }, pressed: { opacity: 0.75 }, fullWidth: { width: '100%' } });
