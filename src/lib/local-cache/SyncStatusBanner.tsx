import { useEffect, useState } from 'react';
import { Alert, Platform, StyleSheet, View } from 'react-native';
import { useAuth } from '@/features/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { ThemedText } from '@/components/ui/text';
import { useTheme } from '@/components/ui/theme-provider';
import { buildSyncEnabled } from './runtime-config';
import { getSyncState, subscribeSyncState, type SyncState } from './status';
import { listPendingOperations } from './outbox';
import { discardFailedOperation, retryFailedOperation } from './sync';
import type { OfflineOperation } from './types';

function reason(operation: OfflineOperation | null): string {
  const raw = operation?.last_error?.toLowerCase() ?? '';
  if (/access|permission|role|42501|archiv|доступ/i.test(raw)) return 'Возможно, доступ к пункту изменился.';
  if (/invalid|value|range|22023|23514/i.test(raw)) return 'Сервер отклонил значение.';
  return 'Сервер отклонил изменение.';
}

function changes(count: number): string {
  const tail = count % 100;
  const word = tail >= 11 && tail <= 14 ? 'изменений'
    : count % 10 === 1 ? 'изменение' : count % 10 >= 2 && count % 10 <= 4 ? 'изменения' : 'изменений';
  return `${count} ${word}`;
}

export function SyncStatusBanner() {
  const { state: auth } = useAuth();
  const userId = auth.isLoading ? null : auth.user?.id ?? null;
  const { colors } = useTheme();
  const [loaded, setLoaded] = useState<{ userId: string; snapshot: SyncState; failed: OfflineOperation | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ userId: string; text: string } | null>(null);
  const snapshot = loaded?.userId === userId ? loaded.snapshot : null;
  const failed = loaded?.userId === userId ? loaded.failed : null;
  const displayedError = error?.userId === userId ? error.text : null;

  useEffect(() => {
    if (!userId) return;
    let active = true;
    const refresh = () => {
      void Promise.all([getSyncState(userId), listPendingOperations(userId)]).then(([next, operations]) => {
        if (!active) return;
        setLoaded({ userId, snapshot: next, failed: operations.find((row) => row.status === 'failed') ?? null });
      }).catch(() => { if (active) setError({ userId, text: 'Не удалось прочитать состояние синхронизации на устройстве.' }); });
    };
    refresh();
    const off = subscribeSyncState((changed) => { if (changed === userId) refresh(); });
    return () => { active = false; off(); };
  }, [userId]);

  if (!userId || (!buildSyncEnabled() && !snapshot?.pendingCount && !snapshot?.failedCount && !snapshot?.conflictCount && !displayedError)) return null;
  let message = 'Проверяем синхронизацию…';
  if (displayedError) message = displayedError;
  else if (snapshot?.conflictCount) message = 'Есть конфликт синхронизации';
  else if (snapshot?.failedCount) message = `Не удалось синхронизировать ${changes(snapshot.failedCount)}. ${reason(failed)}`;
  else if (snapshot?.connectivity === 'offline' && snapshot.pendingCount)
    message = `Нет подключения · сохранено на устройстве: ${changes(snapshot.pendingCount)}`;
  else if (snapshot?.isSyncing) message = `Синхронизация ${snapshot.progress?.done ?? 0} из ${snapshot.progress?.total ?? snapshot.pendingCount}`;
  else if (snapshot?.lastErrorKind === 'disabled') message = snapshot.pendingCount
    ? `Синхронизация временно отключена · сохранено на устройстве: ${changes(snapshot.pendingCount)}`
    : 'Синхронизация временно отключена';
  else if (snapshot?.lastErrorKind === 'config-unavailable') message = snapshot.pendingCount
    ? `Не удалось проверить настройки синхронизации · сохранено на устройстве: ${changes(snapshot.pendingCount)}`
    : 'Не удалось проверить настройки синхронизации';
  else if (snapshot?.pendingCount) message = `Сохранено на устройстве: ${changes(snapshot.pendingCount)}`;
  else if (snapshot?.lastErrorKind) message = 'Не удалось проверить синхронизацию. Повторите позже.';
  else if (snapshot?.lastSuccessfulSyncAt) message = 'Все изменения синхронизированы';

  const retry = () => {
    if (!failed || !userId || busy) return;
    setBusy(true); setError(null);
    void retryFailedOperation(userId, failed.operation_id).catch((cause: unknown) =>
      setError({ userId, text: (cause as Error).message || 'Повторить не удалось.' })).finally(() => setBusy(false));
  };
  const discard = () => {
    if (!failed || !userId || busy) return;
    const act = () => {
      setBusy(true); setError(null);
      void discardFailedOperation(userId, failed.operation_id).catch((cause: unknown) =>
        setError({ userId, text: (cause as Error).message || 'Отменить изменение не удалось.' })).finally(() => setBusy(false));
    };
    if (Platform.OS === 'web') {
      if (window.confirm('Отменить локальное изменение? Несинхронизированное изменение будет удалено с устройства.')) act();
    } else Alert.alert('Отменить локальное изменение?', 'Несинхронизированное изменение пункта будет удалено с устройства.', [
      { text: 'Оставить', style: 'cancel' }, { text: 'Отменить изменение', style: 'destructive', onPress: act },
    ]);
  };
  return <View pointerEvents={failed ? 'auto' : 'none'} style={[styles.banner, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <ThemedText type="small" accessibilityLiveRegion="polite" style={styles.label}>{message}</ThemedText>
    {failed && <View style={styles.actions}>
      <Button size="sm" disabled={busy} onPress={retry}>Повторить</Button>
      <Button size="sm" variant="outline" disabled={busy} onPress={discard}>Отменить локальное изменение</Button>
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  banner: { position: 'absolute', bottom: 90, left: 16, right: 16, zIndex: 900,
    borderWidth: 1, borderRadius: 8, padding: 12, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  label: { flexShrink: 1 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
