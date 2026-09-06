import { ReactNode } from 'react';
import { StyleSheet, ScrollView, View, KeyboardAvoidingView, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ui/view';
import { colors, layout, spacing } from '@/components/ui/theme';

/**
 * Screen — base layout for auth pages.
 *
 * Provides:
 *   - Centered, content-aware container
 *   - ScrollView for small screens
 *   - KeyboardAvoidingView for input forms
 *   - Responsive max-width for desktop
 */

type ScreenProps = {
  children: ReactNode;
  scrollable?: boolean;
  centerContent?: boolean;
  padded?: boolean;
  maxWidth?: number;
  contentStyle?: StyleProp<ViewStyle>;
};

export function Screen({
  children,
  scrollable = false,
  centerContent = true,
  padded = true,
  maxWidth = layout.appMaxWidth,
  contentStyle,
}: ScreenProps) {
  const insets = useSafeAreaInsets();
  const safePadding = { paddingBottom: insets.bottom + spacing.lg };
  const content = scrollable ? (
    <ScrollView
      contentContainerStyle={[styles.scrollContent, { maxWidth }, centerContent && styles.centered, padded && styles.padded, safePadding, contentStyle]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.content, { maxWidth }, centerContent && styles.centered, padded && styles.padded, safePadding, contentStyle]}>
      {children}
    </View>
  );

  return (
    <ThemedView style={styles.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.container}
      >
        {content}
      </KeyboardAvoidingView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flex: 1,
    width: '100%',
    alignSelf: 'center',
  },
  scrollContent: {
    flexGrow: 1,
    width: '100%',
    alignSelf: 'center',
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  padded: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
  },
});
