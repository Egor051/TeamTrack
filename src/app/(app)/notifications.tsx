import { useCallback, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen } from '@/components/ui/screen';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { ThemedText } from '@/components/ui/text';
import { useUser } from '@/features/auth/AuthProvider';
import { fetchNotifications, markAllAsRead, markAsRead, subscribeToNotifications, type Notification } from '@/features/notifications/notifications';
import { userMessage } from '@/lib/errors/user-message';
import { layout, spacing } from '@/components/ui/theme';
import { useTheme } from '@/components/ui/theme-provider';

const PAGE_SIZE = 100;

export default function NotificationsScreen() {
  const { colors: theme } = useTheme();
  const user = useUser();
  const [items, setItems] = useState<Notification[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestRef = useRef(0);
  const itemsRef = useRef<Notification[]>([]);

  const load = useCallback(async (reset = true) => {
    const request = ++requestRef.current;
    if (reset) setLoading(true); else setLoadingMore(true);
    try {
      const offset = reset ? 0 : itemsRef.current.length;
      const page = await fetchNotifications(PAGE_SIZE, offset);
      if (request !== requestRef.current) return;
      if (reset) {
        itemsRef.current = page;
        setItems(page);
      } else {
        setItems((prev) => {
          const next = [...prev, ...page];
          itemsRef.current = next;
          return next;
        });
      }
      setHasMore(page.length === PAGE_SIZE);
      setError('');
    } catch (e) {
      if (request === requestRef.current) setError(userMessage(e, 'Не удалось загрузить уведомления.'));
    } finally {
      if (request === requestRef.current) {
        if (reset) setLoading(false); else setLoadingMore(false);
      }
    }
  }, []);

  useFocusEffect(useCallback(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    if (!user) return () => clearTimeout(timer);
    const cleanup = subscribeToNotifications(user.id, () => { void load(); });
    return () => {
      clearTimeout(timer);
      requestRef.current += 1;
      cleanup();
    };
  }, [load, user]));

  if (!user) return <LoadingState label="Завершаем сеанс..." />;

  async function read(item: Notification) {
    if (!item.is_read) {
      try {
        await markAsRead(item.id);
        setItems((prev) => prev.map((n) => n.id === item.id ? { ...n, is_read: true, read_at: new Date().toISOString() } : n));
      } catch (e) {
        setError(userMessage(e, 'Не удалось отметить уведомление.'));
        return;
      }
    }
    if (item.project_id) {
      router.push(
        (item.task_id
          ? `/projects/${item.project_id}/tasks/${item.task_id}`
          : `/projects/${item.project_id}`) as never,
      );
    }
  }

  async function markReadOnly(item: Notification) {
    if (item.is_read) return;
    try {
      await markAsRead(item.id);
      setItems((prev) => prev.map((n) => n.id === item.id ? { ...n, is_read: true, read_at: new Date().toISOString() } : n));
    } catch (e) {
      setError(userMessage(e, 'Не удалось отметить уведомление.'));
    }
  }

  async function allRead() {
    try {
      await markAllAsRead();
      setItems((prev) => prev.map((n) => ({ ...n, is_read: true, read_at: n.read_at ?? new Date().toISOString() })));
    } catch (e) {
      setError(userMessage(e, 'Не удалось обновить уведомления.'));
    }
  }

  return <Screen padded={false} centerContent={false}>
    <ScrollView refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={theme.primary} />} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <PageHeader title="Уведомления" onBack={() => router.back()} actions={items.some((i) => !i.is_read) ? <Button size="sm" variant="outline" onPress={() => void allRead()}>Прочитать все</Button> : null} />
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : loading && !items.length ? <LoadingState label="Загружаем уведомления..." /> : !items.length ? <EmptyState title="Уведомлений пока нет" description="Здесь появится информация о доступе к задачам и изменениях чек-листа." /> : <View style={styles.list}>
        {items.map((item) => <Card key={item.id} style={!item.is_read ? [styles.readCard, { borderColor: theme.primary }] : undefined}>
          <Pressable onPress={() => void read(item)} accessibilityRole="button" accessibilityLabel={`${item.is_read ? 'Прочитано' : 'Новое'} уведомление: ${item.title}`} style={styles.pressableContent}>
            <View style={styles.header}><ThemedText type="h3" style={styles.flex}>{item.title}</ThemedText>{!item.is_read ? <Badge tone="primary">Новое</Badge> : <Badge tone="neutral">Прочитано</Badge>}</View>
            <ThemedText>{item.body}</ThemedText>
            <ThemedText type="caption">{new Date(item.created_at).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' })}</ThemedText>
          </Pressable>
          {!item.is_read ? <Button size="sm" variant="ghost" onPress={() => void markReadOnly(item)}>Отметить прочитанным</Button> : null}
        </Card>)}
        {hasMore ? <Button size="sm" variant="outline" loading={loadingMore} onPress={() => void load(false)}>Загрузить ещё</Button> : null}
      </View>}
    </ScrollView>
  </Screen>;
}

const styles = StyleSheet.create({ content: { width: '100%', maxWidth: layout.readingMaxWidth, alignSelf: 'center', padding: spacing.xl, gap: spacing.lg }, list: { gap: spacing.md }, header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md }, flex: { flex: 1 }, readCard: { borderLeftWidth: 4 }, pressableContent: { gap: spacing.sm } });
