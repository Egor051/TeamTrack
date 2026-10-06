import { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useAuth } from '@/features/auth/AuthProvider';
import { ThemedText } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useTheme } from './theme-provider';
import type { RealtimeStatus } from '@/lib/supabase/realtime';
import { subscribeConflictChanges } from '@/lib/local-cache/conflicts';
import { getSyncState, subscribeSyncState, type SyncState } from '@/lib/local-cache/status';
import { listPendingOperations } from '@/lib/local-cache/outbox';
import { discardFailedOperation, retryFailedOperation } from '@/lib/local-cache/sync';
import type { OfflineOperation } from '@/lib/local-cache/types';

export function compactSyncStatus(status: RealtimeStatus, snapshot: SyncState | null, readError = false) {
  const count = snapshot?.unsyncedCount ?? 0;
  let label: string;
  let tone: 'success' | 'warning' | 'destructive';
  if (snapshot?.conflictCount) { label = 'конфликт'; tone = 'destructive'; }
  else if (snapshot?.failedCount || readError) { label = 'ошибка'; tone = 'destructive'; }
  else if (snapshot?.connectivity === 'offline') { label = 'офлайн'; tone = 'warning'; }
  else if (snapshot?.isSyncing) { label = 'в процессе'; tone = 'warning'; }
  else if (count) { label = 'ожидает'; tone = 'warning'; }
  else if (snapshot?.lastErrorKind && snapshot.lastErrorKind !== 'disabled') { label = 'ошибка'; tone = 'destructive'; }
  else if (snapshot?.connectivity === 'unknown') { label = 'подключение...'; tone = 'warning'; }
  else if (status === 'error') { label = 'автообновление недоступно'; tone = 'warning'; }
  else if (status === 'reconnecting' || status === 'disconnected') { label = 'переподключение...'; tone = 'warning'; }
  else if (snapshot?.connectivity === 'online') { label = 'подключено'; tone = 'success'; }
  else if (!snapshot && status === 'connected') { label = 'подключение...'; tone = 'warning'; }
  else if (status === 'connecting') { label = 'подключение...'; tone = 'warning'; }
  else { label = 'подключено'; tone = 'success'; }
  return { text: `Синхронизация: ${label}${count ? ` · ${count} несинхр.` : ''}`, tone };
}

function failedReason(operation: OfflineOperation): string {
  const raw = operation.last_error?.toLowerCase() ?? '';
  if (/access|permission|role|42501|archiv|доступ/i.test(raw)) return 'Возможно, доступ к пункту изменился.';
  if (/invalid|value|range|22023|23514/i.test(raw)) return 'Сервер отклонил значение.';
  return 'Сервер отклонил изменение.';
}

export function RealtimeIndicator({ status, compact = false }: { status: RealtimeStatus; compact?: boolean }) {
  const { colors: theme } = useTheme();
  const { state: auth } = useAuth();
  const userId = auth.isLoading ? null : auth.user?.id ?? null;
  const [loaded, setLoaded] = useState<{ userId: string; snapshot: SyncState; failed: OfflineOperation | null } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ userId: string; text: string } | null>(null);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const snapshot = loaded?.userId === userId ? loaded.snapshot : null;
  const failed = loaded?.userId === userId ? loaded.failed : null;
  const hasReadError = Boolean(userId && readError === userId);
  const error = actionError?.userId === userId ? actionError.text : null;
  const busy = Boolean(userId && busyUser === userId);

  useEffect(() => {
    if (!userId) return;
    let active = true;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void Promise.all([getSyncState(userId), listPendingOperations(userId)]).then(([next, operations]) => {
        if (!active || current !== generation) return;
        setLoaded({ userId, snapshot: next, failed: operations.find((row) => row.status === 'failed') ?? null });
        setReadError(null);
      }).catch(() => { if (active && current === generation) setReadError(userId); });
    };
    refresh();
    const changed = (changedUserId: string) => { if (changedUserId === userId) refresh(); };
    const offSync = subscribeSyncState(changed);
    const offConflicts = subscribeConflictChanges(changed);
    return () => { active = false; offSync(); offConflicts(); };
  }, [userId]);

  const { text, tone } = compactSyncStatus(status, snapshot, hasReadError);
  const canExpand = Boolean(failed || hasReadError || error);
  const expanded = canExpand && expandedUser === userId;
  const retry = async () => {
    if (!failed || !userId || busy) return;
    setBusyUser(userId); setActionError(null);
    try { await retryFailedOperation(userId, failed.operation_id); }
    catch { setActionError({ userId, text: 'Повторить не удалось. Проверьте подключение и доступ к пункту.' }); }
    finally { setBusyUser((previous) => previous === userId ? null : previous); }
  };
  const discard = () => {
    if (!failed || !userId || busy) return;
    const act = async () => {
      setBusyUser(userId); setActionError(null);
      try { await discardFailedOperation(userId, failed.operation_id); }
      catch { setActionError({ userId, text: 'Отменить изменение не удалось. Проверьте подключение и доступ к пункту.' }); }
      finally { setBusyUser((previous) => previous === userId ? null : previous); }
    };
    if (Platform.OS === 'web') {
      if (window.confirm('Отменить локальное изменение? Несинхронизированное изменение будет удалено с устройства.')) void act();
    } else Alert.alert('Отменить локальное изменение?', 'Несинхронизированное изменение пункта будет удалено с устройства.', [
      { text: 'Оставить', style: 'cancel' }, { text: 'Отменить изменение', style: 'destructive', onPress: () => void act() },
    ]);
  };
  const content = <><View style={[styles.dot, { backgroundColor: theme[tone] }]} />
    <ThemedText type="caption" accessibilityLiveRegion="polite"
      numberOfLines={compact ? 1 : undefined}
      style={[styles.label, tone !== 'success' && { color: theme[tone], fontWeight: '600' }]}>{text}</ThemedText></>;
  return <View style={styles.container}>
    {canExpand ? <Pressable accessibilityRole="button" accessibilityLabel={text}
      accessibilityHint="Показать или скрыть действия синхронизации" accessibilityState={{ expanded }}
      onPress={() => setExpandedUser(expanded ? null : userId)} style={styles.row}>{content}</Pressable>
      : <View accessible accessibilityLabel={text} style={styles.row}>{content}</View>}
    {expanded && <View style={[styles.details, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      {hasReadError && <ThemedText type="small">Не удалось прочитать состояние синхронизации на устройстве.</ThemedText>}
      {failed && <><ThemedText type="small">{failedReason(failed)}</ThemedText>
        <View style={styles.actions}>
          <Button size="sm" disabled={busy} onPress={() => void retry()}>Отправить изменение снова</Button>
          <Button size="sm" variant="outline" disabled={busy} onPress={discard}>Отменить локальное изменение</Button>
        </View></>}
      {error && <ThemedText type="small" accessibilityRole="alert" style={{ color: theme.destructive }}>{error}</ThemedText>}
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  container: { gap: 8, flexShrink: 1, maxWidth: '100%', minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  label: { fontWeight: '400', flexShrink: 1 },
  details: { borderWidth: 1, borderRadius: 8, padding: 12, gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
