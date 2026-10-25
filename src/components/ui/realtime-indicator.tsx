import { useRef, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useAuth } from '@/features/auth/AuthProvider';
import { ThemedText } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useTheme } from './theme-provider';
import type { RealtimeStatus } from '@/lib/supabase/realtime';
import { type SyncState } from '@/lib/local-cache/status';
import { useSyncIndicator } from '@/lib/local-cache/use-sync-indicator';
import { discardFailedOperation, retryFailedOperation, inspectReviewOperation } from '@/lib/local-cache/sync';
import { inspectOnlineMutation, acknowledgeOnlineReview, retryOnlineMutation } from '@/lib/supabase/mutation';
import type { OfflineOperation } from '@/lib/local-cache/types';
import type { PendingMutation } from '@/lib/supabase/mutation';

export function compactSyncStatus(status: RealtimeStatus, snapshot: SyncState | null, readError = false) {
  const count = snapshot?.unsyncedCount ?? 0;
  let label: string;
  let tone: 'success' | 'warning' | 'destructive';
  if (snapshot?.reviewCount) { label = 'требуется согласование'; tone = 'warning'; }
  else if (snapshot?.conflictCount) { label = 'конфликт'; tone = 'destructive'; }
  else if (snapshot?.failedCount || readError) { label = 'ошибка'; tone = 'destructive'; }
  else if (snapshot?.connectivity === 'offline') { label = 'офлайн'; tone = 'warning'; }
  else if (snapshot?.connectivity === 'degraded') {
    label = snapshot.networkIssue === 'auth-service' ? 'сервис входа недоступен' : 'сервер недоступен'; tone = 'warning';
  }
  else if (snapshot?.lastErrorKind === 'auth' || snapshot?.networkIssue === 'authorization') { label = 'требуется авторизация'; tone = 'destructive'; }
  else if (snapshot?.isSyncing) { label = 'в процессе'; tone = 'warning'; }
  else if (count) { label = 'ожидает'; tone = 'warning'; }
  else if (snapshot?.lastErrorKind && snapshot.lastErrorKind !== 'disabled') { label = 'ошибка'; tone = 'destructive'; }
  else if (snapshot?.connectivity === 'unknown') { label = 'подключение...'; tone = 'warning'; }
  else if (status === 'error') { label = 'автообновление недоступно'; tone = 'warning'; }
  else if (status === 'reconnecting' || status === 'disconnected') { label = 'переподключение...'; tone = 'warning'; }
  else if (snapshot?.connectivity === 'online') { label = 'подключено'; tone = 'success'; }
  else if (!snapshot && status === 'connected') { label = 'подключение...'; tone = 'warning'; }
  else if (status === 'connecting') { label = 'подключение...'; tone = 'warning'; }
  else { label = 'подключение...'; tone = 'warning'; }
  return { text: `Синхронизация: ${label}${count ? ` · ${count} несинхр.` : ''}`, tone };
}

function failedReason(operation: OfflineOperation): string {
  const raw = operation.last_error?.toLowerCase() ?? '';
  if (/access|permission|role|42501|archiv|доступ/i.test(raw)) return 'Возможно, доступ к пункту изменился.';
  if (/invalid|value|range|22023|23514/i.test(raw)) return 'Сервер отклонил значение.';
  return 'Сервер отклонил изменение.';
}

function savedDraft(mutation: PendingMutation): string {
  const labels: Record<string, string> = { p_name: 'Название', p_title: 'Название', p_description: 'Описание',
    p_display_name: 'Имя', p_comment: 'Комментарий', p_identifier: 'Участник', p_role: 'Роль',
    p_deadline: 'Срок', p_deadline_at: 'Срок', p_percentage: 'Прогресс', p_completed: 'Выполнено' };
  const fields = Object.entries(mutation.args ?? {}).filter(([key]) => key in labels)
    .map(([key, value]) => `${labels[key]}: ${value === null ? 'не задано' : typeof value === 'boolean' ? (value ? 'да' : 'нет') : String(value)}`);
  return fields.join(' · ') || 'Параметры действия сохранены. Сверьте изменения на соответствующем экране.';
}

export function RealtimeIndicator({ status, compact = false }: { status: RealtimeStatus; compact?: boolean }) {
  const { colors: theme } = useTheme();
  const { state: auth } = useAuth();
  const userId = auth.isLoading ? null : auth.user?.id ?? null;
  const { snapshot, failed, review, onlineReview, readError: hasReadError } = useSyncIndicator(userId);
  const [reviewed, setReviewed] = useState<{ userId: string; id: string; online?: Awaited<ReturnType<typeof inspectOnlineMutation>>;
    offline?: Awaited<ReturnType<typeof inspectReviewOperation>> } | null>(null);
  const [actionError, setActionError] = useState<{ userId: string; text: string } | null>(null);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const actionRef = useRef<string | null>(null);
  const error = actionError?.userId === userId ? actionError.text : null;
  const busy = Boolean(userId && busyUser === userId);

  const indicator = compactSyncStatus(status, snapshot, hasReadError);
  const text = onlineReview ? 'Синхронизация: требуется согласование' : indicator.text;
  const tone = onlineReview ? 'warning' : indicator.tone;
  const canExpand = Boolean(failed || review || onlineReview || hasReadError || error);
  const expanded = canExpand && expandedUser === userId;
  const reviewId = review?.operation_id ?? onlineReview?.mutation.id;
  const currentReview = reviewed?.userId === userId && reviewed.id === reviewId ? reviewed : null;
  const inspect = async () => {
    if (!userId || !reviewId || busy || actionRef.current === userId) return;
    actionRef.current = userId; setBusyUser(userId); setActionError(null); setReviewed(null);
    try {
      const result = review ? { offline: await inspectReviewOperation(userId, review.operation_id) }
        : { online: await inspectOnlineMutation(userId, onlineReview!.key) };
      setReviewed({ userId, id: reviewId, ...result });
    } catch { setActionError({ userId, text: 'Не удалось получить актуальное состояние. Черновик сохранён.' }); }
    finally { if (actionRef.current === userId) actionRef.current = null; setBusyUser(previous => previous === userId ? null : previous); }
  };
  const acceptCurrent = async () => {
    if (!userId || !currentReview || busy || actionRef.current === userId) return;
    actionRef.current = userId; setBusyUser(userId); setActionError(null);
    try {
      if (review) await discardFailedOperation(userId, review.operation_id);
      else if (onlineReview && currentReview.online) await acknowledgeOnlineReview(userId, onlineReview.key, currentReview.online.guard, currentReview.online.resolution);
      setReviewed(null);
    } catch { setActionError({ userId, text: 'Состояние изменилось. Проверьте данные ещё раз.' }); }
    finally { if (actionRef.current === userId) actionRef.current = null; setBusyUser(previous => previous === userId ? null : previous); }
  };
  const retryOnline = async () => {
    if (!userId || !onlineReview || !currentReview?.online || busy || actionRef.current === userId) return;
    actionRef.current = userId; setBusyUser(userId); setActionError(null);
    try { await retryOnlineMutation(userId, onlineReview.key, currentReview.online.guard, currentReview.online.resolution); }
    catch { setActionError({ userId, text: 'Ответ не подтверждён. Прежнее действие и его черновик сохранены.' }); }
    finally { if (actionRef.current === userId) actionRef.current = null; setBusyUser(previous => previous === userId ? null : previous); }
  };
  const retry = async () => {
    if (!failed || !userId || busy || actionRef.current === userId) return;
    actionRef.current = userId;
    setBusyUser(userId); setActionError(null);
    try { await retryFailedOperation(userId, failed.operation_id); }
    catch { setActionError({ userId, text: 'Повторить не удалось. Проверьте подключение и доступ к пункту.' }); }
    finally { if (actionRef.current === userId) actionRef.current = null; setBusyUser((previous) => previous === userId ? null : previous); }
  };
  const discard = () => {
    if (!failed || !userId || busy) return;
    const act = async () => {
      if (actionRef.current === userId) return;
      actionRef.current = userId;
      setBusyUser(userId); setActionError(null);
      try { await discardFailedOperation(userId, failed.operation_id); }
      catch { setActionError({ userId, text: 'Отменить изменение не удалось. Обновите состояние синхронизации и повторите.' }); }
      finally { if (actionRef.current === userId) actionRef.current = null; setBusyUser((previous) => previous === userId ? null : previous); }
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
      {(review || onlineReview) && <>
        <ThemedText type="small">Результат действия не удалось подтвердить. Оно могло быть выполнено на сервере. Автоматическая повторная отправка остановлена.</ThemedText>
        {review && <ThemedText type="small">Ваш черновик: {review.type === 'set_task_item_percentage' ? `${(review.payload as { percentage: number }).percentage}%`
          : review.type === 'set_task_item_state' ? ((review.payload as { completed: boolean }).completed ? 'Выполнено' : 'Не выполнено')
            : (review.payload as { comment: string | null }).comment || 'Без комментария'}</ThemedText>}
        {onlineReview && <ThemedText type="small">Ваш черновик: {savedDraft(onlineReview.mutation)}</ThemedText>}
        <Button size="sm" disabled={busy} onPress={() => void inspect()}>Получить актуальное состояние</Button>
        {currentReview?.offline && <ThemedText type="small">На сервере: {currentReview.offline.server
          ? `${currentReview.offline.server.percentage}% · ${currentReview.offline.server.comment || 'Без комментария'}` : 'Пункт недоступен'}</ThemedText>}
        {currentReview?.online && <ThemedText type="small">Получено актуальных записей: {currentReview.online.current?.length ?? 0}. Проверьте соответствующий экран перед новым сохранением.</ThemedText>}
        {currentReview?.online?.current?.slice(0, 10).map((row) => <ThemedText key={row.id} type="small">{row.label}{row.detail ? ` · ${row.detail}` : ''}</ThemedText>)}
        {currentReview?.online?.resolution.state === 'unknown' && onlineReview?.mutation.handle &&
          <Button size="sm" disabled={busy} onPress={() => void retryOnline()}>Повторить прежнюю отправку</Button>}
        {currentReview && (!currentReview.online || ['completed', 'result_redacted', 'expired', 'history_reset', 'not_applied', 'never_sent'].includes(currentReview.online.resolution.state)) && <>
          <ThemedText type="small">После сверки можно закрыть это уведомление. Новое сохранение будет отдельным действием. Удаление локального черновика не отменяет возможное выполненное действие на сервере.</ThemedText>
          <Button size="sm" variant="outline" disabled={busy} onPress={() => void acceptCurrent()}>{review ? 'Оставить серверное и убрать черновик' : 'Я сверил данные, закрыть уведомление'}</Button>
        </>}
      </>}
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
