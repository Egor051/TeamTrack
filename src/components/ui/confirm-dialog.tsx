import { StyleSheet, View } from 'react-native';
import { ModalLayer } from './modal-layer';
import { Button } from '@/components/ui/button';
import { ThemedText } from '@/components/ui/text';
import { spacing } from '@/components/ui/theme';
import { useTheme } from './theme-provider';
import { ErrorMessage } from './error-message';
type ConfirmDialogProps = { visible: boolean; title: string; description: string; confirmLabel: string; error?: string; busy?: boolean; destructive?: boolean; nested?: boolean; onConfirm: () => void; onCancel: () => void };

export function ConfirmDialog({ visible, title, description, confirmLabel, error, busy, destructive = true, onConfirm, onCancel }: ConfirmDialogProps) {
  const { colors: theme } = useTheme();
  return <ModalLayer visible={visible} onClose={onCancel} busy={busy} label={title} contentStyle={styles.dialog}>
      <ThemedText type="h2">{title}</ThemedText>
      <ThemedText style={[styles.description, { color: theme.textSecondary }]}>{description}</ThemedText>
      <ErrorMessage message={error} type="validation" />
      <View style={styles.actions}>
        <Button variant="outline" disabled={busy} onPress={onCancel}>Отмена</Button>
        <Button variant={destructive ? 'destructive' : 'primary'} loading={busy} onPress={onConfirm}>{confirmLabel}</Button>
      </View>
  </ModalLayer>;
}

const styles = StyleSheet.create({ dialog: { maxWidth: 460, padding: spacing.xl, gap: spacing.lg }, description: { flexShrink: 1 }, actions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: spacing.sm } });
