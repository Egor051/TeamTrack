import { ActivityIndicator, StyleSheet, TouchableOpacity, type TouchableOpacityProps } from 'react-native';
import { ThemedText } from '@/components/ui/text';
import { radii } from '@/components/ui/theme';
import { useTheme } from './theme-provider';
type ButtonProps = { variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive'; size?: 'sm' | 'md' | 'lg'; disabled?: boolean; loading?: boolean; fullWidth?: boolean; onPress?: () => void; children: React.ReactNode } & Omit<TouchableOpacityProps, 'onPress' | 'disabled'>;
export function Button({ variant = 'primary', size = 'md', disabled = false, loading = false, fullWidth = false, onPress, children, style, ...rest }: ButtonProps) {
  const { colors: theme } = useTheme();
  const unavailable = disabled || loading;
  const palette = { primary: theme.primary, secondary: theme.surfaceMuted, outline: 'transparent', ghost: 'transparent', destructive: theme.destructive };
  return <TouchableOpacity onPress={unavailable ? undefined : onPress} disabled={unavailable} activeOpacity={0.72} accessibilityRole="button" accessibilityState={{ disabled: unavailable, busy: loading }} style={[styles.container, { backgroundColor: palette[variant], borderColor: variant === 'outline' || variant === 'secondary' ? theme.borderStrong : undefined }, variant === 'outline' || variant === 'secondary' ? styles.withBorder : undefined, sizes[size], fullWidth && styles.fullWidth, unavailable && styles.disabled, style]} {...rest}>{loading ? <ActivityIndicator size="small" color={variant === 'primary' || variant === 'destructive' ? theme.surface : theme.text} /> : <ThemedText type="small" style={[styles.text, { color: variant === 'primary' || variant === 'destructive' ? theme.surface : variant === 'ghost' ? theme.primary : theme.text }]}>{children}</ThemedText>}</TouchableOpacity>;
}
const sizes = { sm: { minHeight: 44, paddingHorizontal: 12 }, md: { minHeight: 48, paddingHorizontal: 16 }, lg: { minHeight: 52, paddingHorizontal: 20 } };
const styles = StyleSheet.create({ container: { justifyContent: 'center', alignItems: 'center', borderRadius: radii.md, flexDirection: 'row', gap: 8 }, withBorder: { borderWidth: 1 }, text: { fontWeight: '700' }, disabled: { opacity: 0.5 }, fullWidth: { width: '100%' } });
