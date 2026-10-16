import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Link } from 'expo-router';
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

export function AppNavigation() {
  const user = useUser();
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
    const refresh = createReadRefreshScheduler(async () => {
      try {
        const [count, items] = await Promise.allSettled([fetchUnreadCount(), listChecklistOverview()]);
        if (!active || await activeCacheUserId() !== userId) return;
        if ([count, items].some((result) => result.status === 'rejected' && isExplicitAccessError(result.reason))) { setSnapshot(null); return; }
        setSnapshot((previous) => ({ userId, count: count.status === 'fulfilled' ? count.value : previous?.userId === userId ? previous.count : 0,
          items: items.status === 'fulfilled' ? items.value : previous?.userId === userId ? previous.items : [] }));
      } catch (error) { if (active && isExplicitAccessError(error)) setSnapshot(null); }
    });
    refresh.request();
    const cleanups = [subscribeToNotifications(userId, () => refresh.request()),
      ...['task_items', 'tasks', 'projects'].map((table) => subscribeTable(table, { userId, onEvent: () => refresh.request() })),
      subscribeReadModelCommits((commit) => {
        if (commit.userId === userId && commit.keys.some((key) => key === 'checklist-overview' || key === 'notifications:unread-count')) refresh.request();
      })];
    return () => { active = false; refresh.dispose(); cleanups.forEach((cleanup) => cleanup()); };
  }, [user?.id]);
  return <View style={[styles.bar, { backgroundColor: colors.background, borderBottomColor: colors.border, paddingTop: 8 + insets.top }]}>
    <View style={styles.links}>
      <Link href="/notifications" asChild><Button size="sm" variant="outline" accessibilityRole="link" accessibilityLabel={`Уведомления${count ? `, непрочитанных: ${count}` : ''}`} style={attention !== 'normal' ? { borderColor: color } : undefined}>
        <ThemedText type="small" style={{ color, fontWeight: '600' }}>Уведомления{count ? ` · ${count}` : ''}</ThemedText>
      </Button></Link>
      <Link href="/templates" asChild><Button size="sm" variant="outline" accessibilityRole="link">Шаблоны</Button></Link>
      <Link href="/profile" asChild><Button size="sm" variant="ghost" accessibilityRole="link">Профиль</Button></Link>
    </View>
  </View>;
}
const styles = StyleSheet.create({ bar: { borderBottomWidth: 1, paddingHorizontal: 16, paddingVertical: 8 }, links: { width: '100%', maxWidth: layout.appMaxWidth, alignSelf: 'center', flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 } });
