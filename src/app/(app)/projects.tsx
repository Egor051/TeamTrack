import { useCallback, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Link, router, useFocusEffect } from 'expo-router';
import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { ErrorMessage } from '@/components/ui/error-message';
import { listProjects, listMyTasks, type ProjectWithRole, type MyTask } from '@/features/projects/projects';
import { useAuth } from '@/features/auth/AuthProvider';
import { usePermissionVersion } from '@/features/auth/PermissionProvider';
import { fetchUnreadCount, subscribeToNotifications } from '@/features/notifications/notifications';
import { userMessage } from '@/lib/errors/user-message';
import { useTheme } from '@/components/ui/theme-provider';
import { layout, spacing } from '@/components/ui/theme';
import { isCachedResult, isExplicitAccessError, isTransportFailure } from '@/lib/local-cache/cache';
import { RealtimeIndicator } from '@/components/ui/realtime-indicator';
import { subscribeTable, type RealtimeStatus } from '@/lib/supabase/realtime';

const roleLabels: Record<ProjectWithRole['role'], string> = { owner: 'Владелец', admin: 'Администратор', member: 'Участник', viewer: 'Наблюдатель' };

export default function ProjectsScreen() {
  const { state } = useAuth();
  const permissionVersion = usePermissionVersion();
  const { colors: theme } = useTheme();
  const { width } = useWindowDimensions();
  const [projects, setProjects] = useState<ProjectWithRole[]>([]);
  const [myTasks, setMyTasks] = useState<MyTask[]>([]);
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const [unread, setUnread] = useState(0);
  const requestRef = useRef(0);
  const unreadRequestRef = useRef(0);
  const archived = view === 'archived';
  const userId = state.user?.id;
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const [projectsResult, tasksResult] = await Promise.allSettled([
        listProjects(archived ? 'archived' : 'active'),
        archived ? Promise.resolve([] as MyTask[]) : listMyTasks(userId!),
      ]);
      if (projectsResult.status === 'rejected') throw projectsResult.reason;
      if (tasksResult.status === 'rejected' && !isTransportFailure(tasksResult.reason)) throw tasksResult.reason;
      const next = projectsResult.value;
      const mine = tasksResult.status === 'fulfilled' ? tasksResult.value : [];
      if (request !== requestRef.current) return;
      setProjects(next);
      setMyTasks(mine);
      setOffline(isCachedResult(next) || isCachedResult(mine) || tasksResult.status === 'rejected');
    } catch (e) {
      if (request === requestRef.current) {
        if (isExplicitAccessError(e)) { setProjects([]); setMyTasks([]); setOffline(false); }
        setError(userMessage(e, 'Не удалось загрузить проекты.'));
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [archived, userId]);
  useFocusEffect(useCallback(() => { if (!userId) return; void permissionVersion; void load(); return () => { requestRef.current += 1; }; }, [load, permissionVersion, userId]));
  useFocusEffect(useCallback(() => {
    if (!userId) return;
    return subscribeTable('task_items', { userId, onEvent: () => void load(), onStatus: setStatus });
  }, [load, userId]));
  useFocusEffect(useCallback(() => {
    if (!userId) return;
    let active = true;
    const refreshUnread = () => {
      const request = ++unreadRequestRef.current;
      void fetchUnreadCount().then((count) => {
        if (active && request === unreadRequestRef.current) setUnread(count);
      }).catch(() => undefined);
    };
    const cleanup = subscribeToNotifications(userId, refreshUnread);
    refreshUnread();
    return () => {
      active = false;
      unreadRequestRef.current += 1;
      cleanup();
    };
  }, [userId]));
  if (!userId) return <LoadingState label="Завершаем сеанс..." />;
  const wide = width >= layout.desktopBreakpoint;
  return <Screen padded={false} centerContent={false}><ScrollView keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={theme.primary} />} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
    <View style={styles.topbar}><View style={styles.brand}><ThemedText type="h1">Проекты</ThemedText><ThemedText type="small">{state.profile?.display_name || state.user?.email}</ThemedText></View><View style={styles.nav}><Link href={'/templates' as never} asChild><Button accessibilityRole="link" size="sm" variant="outline">Шаблоны</Button></Link><Link href={'/notifications' as never} asChild><Button accessibilityRole="link" size="sm" variant="outline" accessibilityLabel="Уведомления">Уведомления{unread ? ` · ${unread}` : ''}</Button></Link><Link href={'/profile' as never} asChild><Button accessibilityRole="link" size="sm" variant="ghost">Профиль</Button></Link></View></View>
    <View style={styles.intro}><View><ThemedText type="h2">Рабочий обзор</ThemedText><ThemedText type="small">Команды и этапы в одном месте.</ThemedText></View><View style={styles.actions}><RealtimeIndicator status={status} /><Button size="sm" variant="ghost" loading={loading} onPress={() => void load()}>Обновить</Button><Button onPress={() => router.push('/projects/new' as never)}>Создать проект</Button></View></View>
    <SegmentedControl value={view} onChange={setView} accessibilityLabel="Фильтр проектов" options={[{ value: 'active', label: 'Активные' }, { value: 'archived', label: 'Архив' }]} />
    {offline ? <Card><ThemedText type="small">Нет подключения к сети. Показаны сохранённые данные.</ThemedText></Card> : null}
    {!archived ? <View style={styles.section}><ThemedText type="h2">Мои этапы</ThemedText>{myTasks.length ? <View style={[styles.grid, wide && styles.gridWide]}>{myTasks.map((task) => <Card key={task.id} style={wide ? styles.gridCard : undefined} onPress={() => router.push(`/projects/${task.project_id}/tasks/${task.id}` as never)}><View style={styles.cardHeader}><ThemedText type="h3" style={styles.flex}>{task.title}</ThemedText><Badge tone="primary">Мой этап</Badge></View><ThemedText type="small">{task.project_name}</ThemedText></Card>)}</View> : <EmptyState title="Нет назначенных этапов" description="Здесь появятся активные этапы, где вы исполнитель." />}</View> : null}
    {!archived ? <View style={[styles.divider, { backgroundColor: theme.border }]} /> : null}
    <View style={styles.section}><View><ThemedText type="h2">{archived ? 'Архивные проекты' : 'Активные проекты'}</ThemedText><ThemedText type="small">{archived ? 'Проекты, которые больше не участвуют в текущей работе.' : 'Проекты, в которых вы участвуете.'}</ThemedText></View>{error && !projects.length ? <ErrorState message={error} onRetry={load} /> : loading && !projects.length ? <LoadingState label="Загружаем проекты..." /> : !projects.length ? <EmptyState title={archived ? 'Архив пуст' : 'Проектов пока нет'} description={archived ? 'Здесь появятся проекты после архивации.' : 'Создайте первый проект, чтобы начать вести этапы.'} actionLabel={!archived ? 'Создать проект' : undefined} onAction={!archived ? () => router.push('/projects/new' as never) : undefined} /> : <>{error ? <View style={styles.feedback}><ErrorMessage message={error} type="generic" /><Button size="sm" variant="outline" onPress={() => void load()}>Обновить проекты</Button></View> : null}<View style={[styles.grid, wide && styles.gridWide]}>{projects.map((project) => <Card key={project.id} style={wide ? styles.gridCard : undefined} muted={project.status === 'archived'} onPress={() => router.push(`/projects/${project.id}` as never)} accessibilityLabel={`Открыть проект ${project.name}`}><View style={styles.cardHeader}><ThemedText type="h3" style={styles.flex}>{project.name}</ThemedText><Badge tone={project.status === 'archived' ? 'neutral' : 'primary'}>{roleLabels[project.role]}</Badge></View>{project.description ? <ThemedText type="small" numberOfLines={2}>{project.description}</ThemedText> : null}<View style={styles.cardFooter}><Badge tone={project.status === 'archived' ? 'neutral' : 'success'}>{project.status === 'archived' ? 'В архиве' : 'Активный'}</Badge><ThemedText type="caption">{new Date(project.created_at).toLocaleDateString('ru-RU')}</ThemedText></View></Card>)}</View></>}</View>
  </ScrollView></Screen>;
}
const styles = StyleSheet.create({ content: { width: '100%', maxWidth: layout.appMaxWidth, alignSelf: 'center', padding: spacing.xl, gap: spacing.xl }, topbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: spacing.lg }, brand: { gap: spacing.xs }, nav: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }, intro: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: spacing.lg }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center', maxWidth: '100%' }, section: { gap: spacing.md }, feedback: { gap: spacing.sm }, divider: { height: 1 }, grid: { gap: spacing.md }, gridWide: { flexDirection: 'row', flexWrap: 'wrap' }, gridCard: { flexBasis: '48%', flexGrow: 1 }, cardHeader: { flexDirection: 'row', alignItems: 'flex-start', flexWrap: 'wrap', gap: spacing.md }, flex: { flex: 1, minWidth: 0 }, cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.sm } });
