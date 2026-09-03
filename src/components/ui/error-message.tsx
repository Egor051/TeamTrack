import { StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing } from '@/components/ui/theme';

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
  if (!message) {
    return null;
  }

  return (
    <View accessibilityRole="alert" style={[styles.container, type === 'generic' && styles.info]}>
      <Text style={[styles.message, type === 'generic' && styles.infoText]}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  message: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.error,
  },
  container: { width: '100%', backgroundColor: colors.errorSoft, borderRadius: radii.md, padding: spacing.md },
  info: { backgroundColor: colors.primarySoft },
  infoText: { color: colors.primary },
});
