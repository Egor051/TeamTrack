import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Link, usePathname } from 'expo-router';
import { Button } from '@/components/ui/button';
import { ThemedText } from '@/components/ui/text';
import { useTheme } from '@/components/ui/theme-provider';
import { useUser } from '@/features/auth/AuthProvider';
import { fetchUnreadCount, subscribeToNotifications } from './notifications';
import { listChecklistOverview } from '@/features/projects/checklist-overview';
import { useDeadlineClock } from '@/features/projects/use-deadline-clock';
import { deadlineSummary, type ChecklistOverviewItem } from '@/features/projects/deadlines';
import { subscribeReadModelCommits } from '@/lib/local-cache/read-model-events';
import { createReadRefreshScheduler } from '@/lib/local-cache/refresh-scheduler';
import { subscribeTable } from '@/lib/supabase/realtime';
import { activeCacheUserId, isExplicitAccessError } from '@/lib/local-cache/cache';
import { layout } from '@/components/ui/theme';
import { registerScreenRefresh, useAppRefresh } from '@/lib/local-cache/use-screen-refresh';
import { ErrorMessage } from '@/components/ui/error-message';
import { invalidateReadModels } from '@/lib/local-cache/read-freshness';

function NavigationRefresh({ refresh, refreshing }: { refresh: () => Promise<void>; refreshing: boolean }) {
  const { colors } = useTheme();
  const [hint, setHint] = useState(false);
  return <View style={styles.refresh}>
    <Button size="sm" variant="outline" accessibilityLabel="Обновить" accessibilityHint="Обновить данные текущего экрана"
      loading={refreshing} aria-busy={refreshing} onPress={() => void refresh()} style={styles.refreshButton}
      onHoverIn={() => setHint(true)} onHoverOut={() => setHint(false)} onFocus={() => setHint(true)} onBlur={() => setHint(false)}>
      {refreshing ? null : <ThemedText style={styles.refreshIcon}>↻</ThemedText>}
    </Button>
    {hint ? <View pointerEvents="none" style={[styles.refreshHint, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <ThemedText type="caption">Обновить</ThemedText>
    </View> : null}
  </View>;
}

export function AppNavigation() {
  const user = useUser();
  const pathname = usePathname();
  const showRefresh = pathname !== '/projects';
  const { refresh, refreshing, error } = useAppRefresh(user?.id, pathname);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [snapshot, setSnapshot] = useState<{ userId: string; count: number; items: ChecklistOverviewItem[] } | null>(null);
  const items = snapshot?.userId === user?.id ? snapshot?.items ?? [] : [];
  const now = useDeadlineClock(items);
  const attention = deadlineSummary(items, now).state;
  const color = attention === 'overdue' ? colors.destructive : attention === 'urgent' ? colors.warning : colors.text;
  const count = snapshot?.userId === user?.id ? snapshot?.count ?? 0 : 0;
  useEffect(() => {
    if (!user?.id) return;
    const userId = user.id;
    let active = true;
    const load = async (reportFailure = false) => {
      try {
        const [count, items] = await Promise.allSettled([fetchUnreadCount(), listChecklistOverview()]);
        if (!active || await activeCacheUserId() !== userId) return;
        const denied = [count, items].find((result) => result.status === 'rejected' && isExplicitAccessError(result.reason));
        if (denied?.status === 'rejected') { setSnapshot(null); if (reportFailure) throw denied.reason; return; }
        setSnapshot((previous) => ({ userId, count: count.status === 'fulfilled' ? count.value : previous?.userId === userId ? previous.count : 0,
          items: items.status === 'fulfilled' ? items.value : previous?.userId === userId ? previous.items : [] }));
        const failure = [count, items].find((result) => result.status === 'rejected');
        if (reportFailure && failure?.status === 'rejected') throw failure.reason;
      } catch (error) { if (active && isExplicitAccessError(error)) setSnapshot(null); if (reportFailure) throw error; }
    };
    const refresh = createReadRefreshScheduler(load);
    refresh.request();
    const cleanups = [registerScreenRefresh(async () => {
      await invalidateReadModels(userId, ['notifications:unread-count', 'checklist-overview'], 'refresh');
      if (active) await load(true);
    }), subscribeToNotifications(userId, () => refresh.request()),
      ...['task_items', 'tasks', 'projects'].map((table) => subscribeTable(table, { userId, onEvent: () => refresh.request() })),
      subscribeReadModelCommits((commit) => {
        if (commit.userId === userId && commit.keys.some((key) => key === 'checklist-overview' || key === 'notifications:unread-count')) refresh.request();
      })];
    return () => { active = false; refresh.dispose(); cleanups.forEach((cleanup) => cleanup()); };
  }, [user?.id]);
  const notifications = <Link href="/notifications" asChild><Button size="sm" variant="outline" accessibilityRole="link" accessibilityLabel={`Уведомления${count ? `, непрочитанных: ${count}` : ''}`} style={attention !== 'normal' ? { borderColor: color } : undefined}>
        <ThemedText type="small" style={{ color, fontWeight: '600' }}>Уведомления{count ? ` · ${count}` : ''}</ThemedText>
      </Button></Link>;
  return <View style={[styles.bar, showRefresh && styles.refreshBar, { backgroundColor: colors.background, borderBottomColor: colors.border, paddingTop: 8 + insets.top }]}>
    <View style={styles.links}>
      {showRefresh ? <View style={styles.notificationActions}><NavigationRefresh refresh={refresh} refreshing={refreshing} />{notifications}</View> : notifications}
      <Link href="/templates" asChild><Button size="sm" variant="outline" accessibilityRole="link">Шаблоны</Button></Link>
      <Link href="/profile" asChild><Button size="sm" variant="ghost" accessibilityRole="link">Профиль</Button></Link>
    </View>
    {showRefresh && error ? <View style={styles.feedback}><ErrorMessage message={error} /></View> : null}
  </View>;
}
const styles = StyleSheet.create({ bar: { borderBottomWidth: 1, paddingHorizontal: 16, paddingVertical: 8 }, links: { width: '100%', maxWidth: layout.appMaxWidth, alignSelf: 'center', flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 },
  refreshBar: { zIndex: 1 }, notificationActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, maxWidth: '100%' },
  refresh: { zIndex: 1 }, refreshButton: { width: 44, height: 44, paddingHorizontal: 0, paddingVertical: 0, gap: 0 },
  refreshIcon: { fontSize: 24, lineHeight: 28 }, refreshHint: { position: 'absolute', top: 48, left: 0, padding: 8, borderWidth: 1, borderRadius: 8, minWidth: 80 },
  feedback: { width: '100%', maxWidth: layout.appMaxWidth, alignSelf: 'center', marginTop: 8 },
});
