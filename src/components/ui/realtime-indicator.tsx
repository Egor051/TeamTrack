import { StyleSheet, View } from 'react-native';
import { ThemedText } from '@/components/ui/text';
import { colors } from '@/components/ui/theme';
import type { RealtimeStatus } from '@/lib/supabase/realtime';
export function RealtimeIndicator({ status }: { status: RealtimeStatus }) { const labels: Record<RealtimeStatus, string> = { connecting: 'Подключение', connected: 'Синхронизировано', reconnecting: 'Переподключение', disconnected: 'Нет соединения', error: 'Ошибка синхронизации' }; const attention = status !== 'connected'; return <View accessible accessibilityLabel={`Realtime: ${labels[status]}`} style={styles.row}><View style={[styles.dot, attention && styles.attention]} /><ThemedText type="caption" style={[styles.label, attention && styles.attentionLabel]}>{labels[status]}</ThemedText></View>; }
const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: 6 }, dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.success }, attention: { backgroundColor: colors.warning }, label: { color: colors.textMuted }, attentionLabel: { color: colors.warning, fontWeight: '600' } });
