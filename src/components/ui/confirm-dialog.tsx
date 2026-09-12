import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { ThemedText } from '@/components/ui/text';
import { colors, radii, spacing } from '@/components/ui/theme';
import { useTheme } from './theme-provider';
type ConfirmDialogProps = { visible: boolean; title: string; description: string; confirmLabel: string; busy?: boolean; destructive?: boolean; nested?: boolean; onConfirm: () => void; onCancel: () => void };
const NESTED_CONFIRM_LAYER = 20;
const NESTED_CONFIRM_DIALOG_LAYER = NESTED_CONFIRM_LAYER + 1;

export function ConfirmDialog({ visible, title, description, confirmLabel, busy, destructive = true, nested = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const { colors: theme } = useTheme();
  if (nested && !visible) return null;
  const content = <View style={[styles.backdrop, { backgroundColor: theme.overlay }]}>
    <Pressable style={styles.dismissLayer} onPress={busy ? undefined : onCancel} accessibilityRole="button" accessibilityLabel="Закрыть диалог" />
    <View style={[styles.dialog, { backgroundColor: theme.surface }]} accessibilityViewIsModal accessibilityRole="alert">
      <ThemedText type="h2">{title}</ThemedText>
      <ThemedText style={[styles.description, { color: theme.textSecondary }]}>{description}</ThemedText>
      <View style={styles.actions}>
        <Button variant="outline" disabled={busy} onPress={onCancel}>Отмена</Button>
        <Button variant={destructive ? 'destructive' : 'primary'} loading={busy} onPress={onConfirm}>{confirmLabel}</Button>
      </View>
    </View>
  </View>;
  if (nested) return <View style={styles.nestedRoot} pointerEvents="box-none">{content}</View>;
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={busy ? () => undefined : onCancel}>{content}</Modal>;
}

const styles = StyleSheet.create({ nestedRoot: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: NESTED_CONFIRM_LAYER, elevation: NESTED_CONFIRM_LAYER }, backdrop: { flex: 1, backgroundColor: colors.overlay, padding: spacing.lg, justifyContent: 'center', alignItems: 'center' }, dismissLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }, dialog: { width: '100%', maxWidth: 460, backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.xl, gap: spacing.lg, zIndex: NESTED_CONFIRM_DIALOG_LAYER, elevation: NESTED_CONFIRM_DIALOG_LAYER }, description: { color: colors.textSecondary }, actions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: spacing.sm } });
