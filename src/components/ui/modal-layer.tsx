import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from './theme-provider';

// Native Modal also supplies RN Web's active-modal stack and focus trap.
// The dismiss layer consumes the click before it can reach a parent window.
export function ModalLayer({ visible, onClose, busy = false, children, contentStyle, label }: {
  visible: boolean; onClose: () => void; busy?: boolean; children: ReactNode;
  contentStyle?: StyleProp<ViewStyle>; label?: string;
}) {
  const { colors } = useTheme();
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { if (!busy) onClose(); }}>
    <View style={[styles.backdrop, { backgroundColor: colors.overlay }]}>
      <Pressable style={styles.dismiss} accessibilityRole="button" accessibilityLabel="Закрыть окно" disabled={busy} onPress={onClose} />
      <View accessibilityViewIsModal accessibilityLabel={label} style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }, contentStyle]}>{children}</View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 12 },
  dismiss: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  sheet: { width: '100%', maxWidth: 720, maxHeight: '92%', borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
});
