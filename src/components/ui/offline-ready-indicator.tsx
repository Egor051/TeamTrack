import { Platform, StyleSheet, View } from 'react-native';
import { useOfflineBootstrap } from '@/lib/local-cache/use-offline-bootstrap';
import { runAccountBootstrap } from '@/lib/local-cache/bootstrap';
import type { BootstrapMetadata } from '@/lib/local-cache/bootstrap-types';
import { ThemedText } from './text';
import { Button } from './button';
import { useTheme } from './theme-provider';

export function offlineReadyLabel(meta: BootstrapMetadata): string {
  switch (meta.status) {
    case 'ready': return meta.offline_ready ? 'Офлайн: готово' : 'Офлайн: частично готово';
    case 'running': return `Офлайн: подготовка ${meta.progress}%`;
    case 'updating': return `Офлайн: обновление ${meta.progress}%`;
    case 'partial': return 'Офлайн: частично готово';
    case 'error': return 'Офлайн: ошибка';
    default: return 'Офлайн: подготовка…';
  }
}
// Rendered only by /projects, independently of RealtimeIndicator.
export function OfflineReadyIndicator() {
  const meta = useOfflineBootstrap();
  const { colors } = useTheme();
  if (Platform.OS !== 'web' || !meta) return null;
  const color = meta.offline_ready ? colors.success : meta.status === 'error' ? colors.destructive : colors.warning;
  return <View style={styles.container}>
    <View style={styles.row} accessibilityLiveRegion="polite"><View style={[styles.dot, { backgroundColor: color }]} /><ThemedText type="caption">{offlineReadyLabel(meta)}</ThemedText></View>
    {meta.error ? <View style={styles.feedback}><ThemedText type="caption">{meta.error}</ThemedText><Button size="sm" variant="ghost" onPress={() => void runAccountBootstrap(meta.user_id, true).catch(() => undefined)}>Повторить</Button></View> : null}
  </View>;
}
const styles = StyleSheet.create({ container: { gap: 4, flexShrink: 1, maxWidth: '100%' }, row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 }, feedback: { gap: 4, maxWidth: 280 } });
