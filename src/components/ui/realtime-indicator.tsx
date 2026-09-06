import { StyleSheet, View } from 'react-native';
import { ThemedText } from '@/components/ui/text';
import { useTheme } from './theme-provider';
import type { RealtimeStatus } from '@/lib/supabase/realtime';
export function RealtimeIndicator({ status }: { status: RealtimeStatus }) { const { colors: theme } = useTheme(); const labels: Record<RealtimeStatus, string> = { connecting: 'Подключение...', connected: 'Синхронизация: подключено', reconnecting: 'Переподключение...', disconnected: 'Нет соединения', error: 'Ошибка синхронизации' }; const attention = status !== 'connected'; return <View accessible accessibilityLabel={labels[status]} style={styles.row}><View style={[styles.dot, { backgroundColor: attention ? theme.warning : theme.success }]} /><ThemedText type="caption" style={[styles.label, attention && { color: theme.warning, fontWeight: '600' }]}>{labels[status]}</ThemedText></View>; }
const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: 6 }, dot: { width: 7, height: 7, borderRadius: 4 }, label: { fontWeight: '400' } });
