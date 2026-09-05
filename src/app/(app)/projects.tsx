import { useCallback, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Link, router, useFocusEffect } from 'expo-router';
import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { listProjects, type ProjectWithRole } from '@/features/projects/projects';
import { useAuth } from '@/features/auth/AuthProvider';
import { fetchUnreadCount, subscribeToNotifications } from '@/features/notifications/notifications';
import { userMessage } from '@/lib/errors/user-message';
import { colors, layout, spacing } from '@/components/ui/theme';

const roleLabels: Record<ProjectWithRole['role'], string> = { owner: 'Владелец', admin: 'Администратор', member: 'Участник', viewer: 'Наблюдатель' };

export default function ProjectsScreen() {
  const { state } = useAuth();
  const [projects, setProjects] = useState<ProjectWithRole[]>([]);
  const [view, setView] = useState<'active' | 'archived'>('active');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unread, setUnread] = useState(0);
  const requestRef = useRef(0);
  const unreadRequestRef = useRef(0);
  const archived = view === 'archived';
  const userId = state.user?.id;
  const load = useCallback(async () => { const request = ++requestRef.current; setLoading(true); setError(''); try { const next = await listProjects(archived); if (request !== requestRef.current) return; setProjects(next); } catch (e) { if (request === requestRef.current) setError(userMessage(e, 'Не удалось загрузить проекты.')); } finally { if (request === requestRef.current) setLoading(false); } }, [archived]);
  useFocusEffect(useCallback(() => { if (!userId) return; void load(); return () => { requestRef.current += 1; }; }, [load, userId]));
  useFocusEffect(useCallback(() => {
    if (!userId) return;
    let active = true;
    const refreshUnread = () => {
      const request = ++unreadRequestRef.current;
      void fetchUnreadCount().then((count) => {
        if (active && request === unreadRequestRef.current) setUnread(count);
      }).catch(() => undefined);
    };
    refreshUnread();
    const cleanup = subscribeToNotifications(userId, refreshUnread);
    return () => {
      active = false;
      unreadRequestRef.current += 1;
      cleanup();
    };
  }, [userId]));
  if (!userId) return <LoadingState label="Завершаем сеанс..." />;
  return <Screen padded={false} centerContent={false}><ScrollView refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
    <View style={styles.topbar}><View style={styles.brand}><ThemedText type="h1">Проекты</ThemedText><ThemedText type="small">{state.profile?.display_name || state.user?.email}</ThemedText></View><View style={styles.nav}><Link href={'/notifications' as never} asChild><Button size="sm" variant="outline" accessibilityLabel="Уведомления">Уведомления{unread ? ` · ${unread}` : ''}</Button></Link><Link href={'/profile' as never} asChild><Button size="sm" variant="ghost">Профиль</Button></Link></View></View>
    <View style={styles.intro}><View><ThemedText type="h2">{archived ? 'Архив проектов' : 'Активные проекты'}</ThemedText><ThemedText type="small">{archived ? 'Проекты, которые больше не участвуют в текущей работе.' : 'Команды и задачи в одном месте.'}</ThemedText></View><Button onPress={() => router.push('/projects/new' as never)}>Создать проект</Button></View>
    <SegmentedControl value={view} onChange={setView} accessibilityLabel="Фильтр проектов" options={[{ value: 'active', label: 'Активные' }, { value: 'archived', label: 'Архив' }]} />
    {error ? <ErrorState message={error} onRetry={load} /> : loading && !projects.length ? <LoadingState label="Загружаем проекты..." /> : !projects.length ? <EmptyState title={archived ? 'Архив пуст' : 'Проектов пока нет'} description={archived ? 'Здесь появятся проекты после архивации.' : 'Создайте первый проект, чтобы начать вести задачи.'} actionLabel={!archived ? 'Создать проект' : undefined} onAction={!archived ? () => router.push('/projects/new' as never) : undefined} /> : <View style={styles.grid}>{projects.map((project) => <Card key={project.id} muted={project.status === 'archived'} onPress={() => router.push(`/projects/${project.id}` as never)} accessibilityLabel={`Открыть проект ${project.name}`}><View style={styles.cardHeader}><ThemedText type="h3" style={styles.flex}>{project.name}</ThemedText><Badge tone={project.status === 'archived' ? 'neutral' : 'primary'}>{roleLabels[project.role]}</Badge></View>{project.description ? <ThemedText style={styles.description} numberOfLines={2}>{project.description}</ThemedText> : null}<View style={styles.cardFooter}><Badge tone={project.status === 'archived' ? 'neutral' : 'success'}>{project.status === 'archived' ? 'В архиве' : 'Активный'}</Badge><ThemedText type="caption">{new Date(project.created_at).toLocaleDateString('ru-RU')}</ThemedText></View></Card>)}</View>}
  </ScrollView></Screen>;
}
const styles = StyleSheet.create({ content: { width: '100%', maxWidth: layout.appMaxWidth, alignSelf: 'center', padding: spacing.xl, gap: spacing.xl }, topbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: spacing.lg }, brand: { gap: spacing.xs }, nav: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }, intro: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: spacing.lg }, grid: { gap: spacing.md }, cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md }, flex: { flex: 1 }, description: { color: colors.textSecondary }, cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm } });
