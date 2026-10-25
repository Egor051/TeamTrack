import { StyleSheet, View } from 'react-native';
import { ThemedText } from '@/components/ui/text';
import { spacing } from '@/components/ui/theme';
import { useTheme } from '@/components/ui/theme-provider';

export function DailyProgressRow({ title, status, stage, completed }: { title: string; status: string; stage?: number; completed: boolean }) {
  const { colors } = useTheme();
  return <View style={[styles.row, { borderColor: colors.border }]}>
    {stage !== undefined ? <ThemedText type="small">Этап {stage}</ThemedText> : null}
    <ThemedText selectable style={styles.text}>{title}</ThemedText>
    <ThemedText selectable style={[styles.text, completed && styles.completed]}>{status}</ThemedText>
  </View>;
}
const styles = StyleSheet.create({
  row: { minWidth: 0, maxWidth: '100%', borderWidth: 1, padding: spacing.md, gap: spacing.sm },
  text: { minWidth: 0, maxWidth: '100%', flexShrink: 1 },
  completed: { color: '#FFFFFF', backgroundColor: '#16835D', fontWeight: '700', padding: spacing.sm },
});
