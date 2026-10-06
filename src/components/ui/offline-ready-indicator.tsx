import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useState } from 'react';
import { useOfflineBootstrap } from '@/lib/local-cache/use-offline-bootstrap';
import type { BootstrapMetadata } from '@/lib/local-cache/bootstrap-types';
import { ThemedText } from './text';
import { useTheme } from './theme-provider';

export function offlineReadyLabel(meta: BootstrapMetadata): string {
  switch (meta.status) {
    case 'checking': return 'Офлайн: проверяем сохранённые данные';
    case 'ready': return meta.offline_ready ? meta.scheme === 'extended' && !meta.extended_ready ? 'Офлайн: базовые данные готовы' : 'Офлайн: готово' : 'Офлайн: частично готово';
    case 'running': return `Офлайн: подготовка ${meta.progress}%`;
    case 'updating': return `Офлайн: обновление ${meta.progress}%`;
    case 'partial': return meta.basic_ready && meta.scheme === 'extended' ? 'Офлайн: базовые данные готовы' : 'Офлайн: частично готово';
    case 'error': return 'Офлайн: ошибка';
    case 'offline_waiting': return 'Офлайн: ожидание сети';
    default: return 'Офлайн: не подготовлено';
  }
}
// Readiness retains its own semantics inside the shared /projects status block.
export function OfflineReadyIndicator({ compact = false }: { compact?: boolean }) {
  const meta = useOfflineBootstrap();
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  if (Platform.OS !== 'web' || !meta) return null;
  const selectedReady = meta.scheme === 'basic' ? meta.basic_ready : meta.extended_ready;
  const color = selectedReady ? colors.success : meta.status === 'error' ? colors.destructive : colors.warning;
  const label = offlineReadyLabel(meta);
  const content = <><View style={[styles.dot, { backgroundColor: color }]} /><ThemedText type="caption" numberOfLines={compact ? 1 : undefined} style={styles.label}>{label}</ThemedText></>;
  return <View style={styles.container}>
    {compact && meta.error ? <Pressable style={styles.row} accessibilityRole="button" accessibilityLabel={label} accessibilityLiveRegion="polite"
      accessibilityHint="Показать или скрыть подробности офлайн-готовности" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}>{content}</Pressable>
      : <View style={styles.row} accessibilityLiveRegion="polite" accessibilityLabel={label}>{content}</View>}
    {meta.error && (!compact || expanded) ? <View style={styles.feedback}><ThemedText type="caption">{meta.error}</ThemedText></View> : null}
  </View>;
}
const styles = StyleSheet.create({ container: { gap: 4, flexShrink: 1, maxWidth: '100%' }, row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { flexShrink: 1 }, dot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 }, feedback: { gap: 4, maxWidth: 280 } });
