import { StyleSheet, Text, View } from 'react-native';
import { radii, spacing } from '@/components/ui/theme';
import { useTheme } from './theme-provider';

/**
 * ErrorMessage — compact error display, suitable for forms.
 *
 * Props:
 *   message?: string
 *   type?: 'auth' | 'validation' | 'generic'
 */

export function ErrorMessage({
  message,
  type = 'generic',
}: { message?: string; type?: 'auth' | 'validation' | 'generic' }) {
  const { colors: theme } = useTheme();
  if (!message) {
    return null;
  }

  const tone = type === 'generic' ? 'warning' : 'error';
  return (
    <View accessibilityRole="alert" style={[styles.container, { backgroundColor: tone === 'warning' ? theme.warningSoft : theme.errorSoft }]}>
      <Text style={[styles.message, { color: tone === 'warning' ? theme.warning : theme.error }]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  message: {
    fontSize: 14,
    lineHeight: 20,
  },
  container: { width: '100%', borderRadius: radii.md, padding: spacing.md },
});
