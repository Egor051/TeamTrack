import { useReadModelUpdates } from '@/lib/local-cache/use-read-model-updates';
import { useOnlineRecovery } from '@/lib/connectivity/use-online-recovery';
import { useCallback, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen } from '@/components/ui/screen';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { ErrorMessage } from '@/components/ui/error-message';
import { ThemedText } from '@/components/ui/text';
import { useUser } from '@/features/auth/AuthProvider';
import { fetchNotificationPage, fetchNotificationFilterOptions, markAllAsRead, markAsRead, notificationBody, notificationRoute, stageNotificationText, subscribeToNotifications, type Notification, type NotificationFilterOptions } from '@/features/notifications/notifications';
import { NotificationFilters } from '@/features/notifications/notification-filters';
import { matchesNotification, notificationTone, NotificationReadState, type NotificationFilters as Filters } from '@/features/notifications/notification-state';
import { isExplicitAccessError } from '@/lib/local-cache/cache';
import { userMessage } from '@/lib/errors/user-message';
import { layout, spacing } from '@/components/ui/theme';
import { useTheme } from '@/components/ui/theme-provider';

const PAGE_SIZE = 100;

function notificationText(item: Notification, value: string): string {
  return item.task_id ? stageNotificationText(value) : value;
}

export default function NotificationsScreen() {
  const { colors: theme } = useTheme();
  const user = useUser();
  const [items, setItems] = useState<Notification[]>([]);
  const [filters, setFilters] = useState<Filters>({});
  const [filterOptions, setFilterOptions] = useState<NotificationFilterOptions>({ projects: [], tasks: [] });
  const [filterError, setFilterError] = useState('');
  const readState = useRef(new NotificationReadState());
  const pageOffset = useRef(0);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [offline, setOffline] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [markingIds, setMarkingIds] = useState<Set<string>>(new Set());
  const requestRef = useRef(0);
  const loadingMoreRequestRef = useRef<number | null>(null);
  const itemsRef = useRef<Notification[]>([]);
  // Keep the guard in a ref as well as state so two taps in the same render
  // cannot enqueue duplicate requests before React has re-rendered.
  const markingIdsRef = useRef(new Set<string>());
  const markingAllRef = useRef(false);

  const load = useCallback(async (reset = true) => {
    const request = ++requestRef.current;
    if (filters.from && filters.to && filters.from > filters.to) {
      setLoadError('Начало периода должно быть раньше конца.'); setLoading(false); setLoadingMore(false); setHasMore(false); setItems([]); itemsRef.current = []; return;
    }
    if (reset) {
      setLoading(true);
      // A refresh supersedes an in-flight page request. Clear its spinner
      // immediately; the stale request must not be able to re-enable it.
      loadingMoreRequestRef.current = null;
      setLoadingMore(false);
    } else {
      loadingMoreRequestRef.current = request;
      setLoadingMore(true);
    }
    try {
      const offset = reset ? 0 : pageOffset.current;
      const result = await fetchNotificationPage(PAGE_SIZE, offset, filters);
      const page = readState.current.accept(result.rows);
      if (request !== requestRef.current) return;
      pageOffset.current = offset + result.rows.length;
      if (reset) {
        itemsRef.current = page;
        setItems(page);
      } else {
        setItems((prev) => {
          const byId = new Map([...prev, ...page].map((row) => [row.id, row]));
          const next = readState.current.apply([...byId.values()]);
          itemsRef.current = next;
          return next;
        });
      }
      setHasMore(result.hasMore);
      setOffline(result.offline);
      setLoadError('');
    } catch (e) {
      if (request === requestRef.current) {
        setLoadError(userMessage(e, 'Не удалось загрузить уведомления.'));
        if (isExplicitAccessError(e)) { setItems([]); itemsRef.current = []; setOffline(false); }
      }
    } finally {
      if (request === requestRef.current) {
        if (reset) setLoading(false);
      }
      if (!reset && loadingMoreRequestRef.current === request) {
        loadingMoreRequestRef.current = null;
        setLoadingMore(false);
      }
    }
  }, [filters]);

  const { scheduleRefresh, refreshFromServer } = useReadModelUpdates(load, { view: 'notifications', userId: user?.id });
  useOnlineRecovery(load);
  useFocusEffect(useCallback(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    if (!user) return () => clearTimeout(timer);
    const cleanup = subscribeToNotifications(user.id, scheduleRefresh);
    return () => {
      clearTimeout(timer);
      requestRef.current += 1;
      cleanup();
    };
  }, [load, user, scheduleRefresh]));
  useFocusEffect(useCallback(() => {
    let active = true;
    const fetchOptions = () => { void fetchNotificationFilterOptions().then((next) => { if (active) { setFilterOptions(next); setFilterError(''); } })
      .catch((error) => { if (active) setFilterError(userMessage(error, 'Не удалось загрузить варианты фильтров.')); }); };
    fetchOptions();
    const cleanup = user ? subscribeToNotifications(user.id, fetchOptions) : () => {};
    return () => { active = false; cleanup(); };
  }, [user]));

  if (!user) return <LoadingState label="Завершаем сеанс..." />;

  async function markItemRead(item: Notification) {
    if (item.is_read) return true;
    if (markingAllRef.current) return false;
    if (markingIdsRef.current.has(item.id)) return false;
    markingIdsRef.current.add(item.id);
    setMarkingIds(new Set(markingIdsRef.current));
    const ids = readState.current.begin([item]);
    itemsRef.current = readState.current.apply(itemsRef.current); setItems(itemsRef.current);
    try {
      await markAsRead(item.id);
      readState.current.confirm(ids);
      itemsRef.current = readState.current.apply(itemsRef.current); setItems(itemsRef.current);
      setActionError('');
      scheduleRefresh();
      return true;
    } catch (e) {
      itemsRef.current = readState.current.rollback(ids, itemsRef.current); setItems(itemsRef.current);
      setActionError(userMessage(e, 'Не удалось отметить уведомление.'));
      return false;
    } finally {
      markingIdsRef.current.delete(item.id);
      setMarkingIds(new Set(markingIdsRef.current));
    }
  }

  async function read(item: Notification) {
    if (!offline && !await markItemRead(item)) return;
    const route = notificationRoute(item);
    if (route) router.push(route as never);
  }

  async function markReadOnly(item: Notification) {
    await markItemRead(item);
  }

  async function allRead() {
    if (markingAllRef.current || markingIdsRef.current.size) return;
    markingAllRef.current = true;
    setMarkingAll(true);
    setActionError('');
    const ids = readState.current.begin(itemsRef.current);
    itemsRef.current = readState.current.apply(itemsRef.current); setItems(itemsRef.current);
    try {
      await markAllAsRead();
      readState.current.confirm(ids);
      itemsRef.current = readState.current.apply(itemsRef.current); setItems(itemsRef.current);
      scheduleRefresh();
    } catch (e) {
      itemsRef.current = readState.current.rollback(ids, itemsRef.current); setItems(itemsRef.current);
      setActionError(userMessage(e, 'Не удалось обновить уведомления.'));
    } finally {
      markingAllRef.current = false;
      setMarkingAll(false);
    }
  }

  return <Screen padded={false} centerContent={false}>
    <ScrollView keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refreshFromServer()} tintColor={theme.primary} />} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <PageHeader title="Уведомления" breadcrumbs={[{ label: 'Проекты', href: '/projects' }, { label: 'Уведомления' }]} actions={!offline && items.some((i) => !i.is_read) ? <Button size="sm" variant="outline" loading={markingAll} disabled={markingAll || markingIds.size > 0} onPress={() => void allRead()}>Прочитать все</Button> : null} />
      <NotificationFilters value={filters} onChange={setFilters} options={filterOptions} />
      {filterError ? <ErrorMessage message={filterError} type="generic" /> : null}
      {actionError ? <ErrorMessage message={actionError} type="validation" /> : null}
      {offline ? <Card><ThemedText type="small">Показаны сохранённые уведомления: все непрочитанные и последние 100 прочитанных. Более старые уведомления и отметка прочтения требуют подключения.</ThemedText></Card> : null}
      {loadError && !items.length ? <ErrorState message={loadError} onRetry={() => void load()} /> : loading && !items.length ? <LoadingState label="Загружаем уведомления..." /> : <View style={styles.list}>
        {loadError ? <View style={styles.feedback}><ErrorMessage message={loadError} type="generic" /><Button size="sm" variant="outline" onPress={() => void refreshFromServer()}>Обновить уведомления</Button></View> : null}
        {!items.some((item) => matchesNotification(item, filters)) ? <EmptyState title={Object.values(filters).some(Boolean) ? 'Нет уведомлений по выбранным условиям' : 'Уведомлений пока нет'} description="Измените или сбросьте фильтры." /> : null}
        {items.filter((item) => matchesNotification(item, filters)).map((item) => <Card key={item.id} tone={notificationTone(item) === 'danger' ? 'destructive' : notificationTone(item) === 'warning' ? 'warning' : undefined} style={!item.is_read ? styles.readCard : undefined}>
          <Pressable onPress={() => void read(item)} disabled={markingAll} accessibilityRole="button" accessibilityLabel={`${item.is_read ? 'Прочитано' : 'Новое'} уведомление: ${notificationText(item, item.title)}`} accessibilityState={{ disabled: markingAll }} style={styles.pressableContent}>
            <View style={styles.header}><ThemedText type="h3" style={styles.flex}>{notificationText(item, item.title)}</ThemedText>{!item.is_read ? <Badge tone="primary">Новое</Badge> : <Badge tone="neutral">Прочитано</Badge>}</View>
            <ThemedText>{notificationBody(item)}</ThemedText>
            <ThemedText type="caption">{new Date(item.created_at).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' })}</ThemedText>
          </Pressable>
          {!offline && !item.is_read ? <Button size="sm" variant="ghost" loading={markingIds.has(item.id)} disabled={markingAll || markingIds.has(item.id)} onPress={() => void markReadOnly(item)}>{markingIds.has(item.id) ? 'Отмечаем…' : 'Отметить прочитанным'}</Button> : null}
        </Card>)}
        {hasMore ? <Button size="sm" variant="outline" loading={loadingMore} onPress={() => void load(false)}>Загрузить ещё</Button> : null}
      </View>}
    </ScrollView>
  </Screen>;
}

const styles = StyleSheet.create({ content: { width: '100%', maxWidth: layout.readingMaxWidth, alignSelf: 'center', padding: spacing.xl, gap: spacing.lg }, list: { gap: spacing.md }, feedback: { gap: spacing.sm }, header: { flexDirection: 'row', alignItems: 'flex-start', flexWrap: 'wrap', gap: spacing.md }, flex: { flex: 1, minWidth: 0 }, readCard: { borderLeftWidth: 4 }, pressableContent: { gap: spacing.sm } });
