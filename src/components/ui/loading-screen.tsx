import { StyleSheet, ActivityIndicator, View } from 'react-native';
import { ThemedView } from '@/components/ui/view';
import { ThemedText } from '@/components/ui/text';
import { useTheme } from './theme-provider';

export function LoadingScreen({
  visible = true,
  text = 'Loading...',
}: {
  visible?: boolean;
  text?: string;
} = {}) {
  const { colors: theme } = useTheme();
  return (
    <ThemedView style={styles.container}>
      {visible && (
        <View style={styles.indicator}>
          <ActivityIndicator size="large" color={theme.primary} />
          <ThemedText type="small" style={styles.text}>
            {text}
          </ThemedText>
        </View>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  indicator: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
  },
  text: {
    fontSize: 14,
  },
});
