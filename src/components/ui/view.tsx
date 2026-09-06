import { StyleSheet, View, ViewProps } from 'react-native';
import { colors, radii, shadows } from '@/components/ui/theme';
import { useTheme } from './theme-provider';

/**
 * ThemedView — container with theme-aware background and optional border.
 */

type ThemedViewProps = {
  type?: 'default' | 'card' | 'backgroundElement' | 'input';
} & ViewProps;

export function ThemedView({
  type = 'default',
  style,
  children,
  ...rest
}: ThemedViewProps) {
  const { colors: theme } = useTheme();
  const viewStyle = [styles[type], style];
  return <View style={[viewStyle, type === 'default' && { backgroundColor: theme.background }, type === 'card' && { backgroundColor: theme.surface, borderColor: theme.border }, type === 'backgroundElement' && { backgroundColor: theme.surfaceMuted }, type === 'input' && { backgroundColor: theme.surface, borderColor: theme.border }]} {...rest}>{children}</View>;
}

const styles = StyleSheet.create({
  default: {
    flex: 1,
    backgroundColor: colors.background,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.card,
  },
  backgroundElement: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radii.md,
    padding: 16,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
});

export default ThemedView;
