import { useEffect, useState, type ReactNode } from 'react';
import { BackHandler, ScrollView, StyleSheet, View } from 'react-native';
import { useAuth } from '@/features/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { LoadingScreen } from '@/components/ui/loading-screen';
import { ThemedText } from '@/components/ui/text';
import { useTheme } from '@/components/ui/theme-provider';
import { chooseServer, subscribeConflictChanges, unresolvedConflicts } from './conflicts';
import { chooseMine, syncPendingOperations } from './sync';
import type { SyncConflict } from './types';

function StateValue({ conflict, mine }: { conflict: SyncConflict; mine: boolean }) {
  const state = mine ? conflict.local_effective_state : conflict.server_state;
  if (!state) return <ThemedText type="body">Пункт удалён на сервере</ThemedText>;
  return <View style={styles.value}>
    {conflict.conflicting_fields.includes('progress') &&
      <ThemedText type="body">{state.percentage}% · {state.is_completed ? 'выполнено' : 'не выполнено'}</ThemedText>}
    {conflict.conflicting_fields.includes('comment') &&
      <ThemedText type="body">{state.comment || 'Без комментария'}</ThemedText>}
    {state.is_archived && <ThemedText type="small">Пункт архивирован</ThemedText>}
  </View>;
}

function Gate({ conflict, index, total, busy, error, onMine, onServer }: {
  conflict: SyncConflict; index: number; total: number; busy: boolean; error: string | null;
  onMine: () => void; onServer: () => void;
}) {
  const { colors } = useTheme();
  return <ScrollView style={{ flex: 1, backgroundColor: colors.background }}
    contentContainerStyle={styles.screen} keyboardShouldPersistTaps="always">
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.borderStrong }]}
      accessibilityViewIsModal importantForAccessibility="yes">
      <ThemedText type="h2">Обнаружен конфликт синхронизации</ThemedText>
      <ThemedText type="small">{conflict.project_name || 'Проект'} / {conflict.task_name || 'Этап'}</ThemedText>
      <ThemedText type="h3">{conflict.item_name}</ThemedText>
      <ThemedText type="small">Изменено: {conflict.conflicting_fields.map((field) => field === 'progress' ? 'прогресс' : 'комментарий').join(', ')}</ThemedText>
      <View style={styles.comparison}>
        <View style={styles.column}><ThemedText type="small">Ваш вариант</ThemedText><StateValue conflict={conflict} mine /></View>
        <View style={styles.column}><ThemedText type="small">Серверный вариант</ThemedText><StateValue conflict={conflict} mine={false} /></View>
      </View>
      {error && <ThemedText type="small" style={{ color: colors.destructive }} accessibilityRole="alert">{error}</ThemedText>}
      <View style={styles.actions}>
        <Button onPress={onMine} disabled={busy || !conflict.server_state} loading={busy} accessibilityLabel="Оставить моё">Оставить моё</Button>
        <Button onPress={onServer} disabled={busy} variant="outline" accessibilityLabel="Оставить серверное">Оставить серверное</Button>
      </View>
      <ThemedText type="caption">Конфликт {index + 1} из {total}</ThemedText>
    </View>
  </ScrollView>;
}

export function ConflictGate({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const userId = state.isLoading ? null : state.user?.id ?? null;
  const [loadedUser, setLoadedUser] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [progress, setProgress] = useState<{ userId: string | null; resolvedCount: number }>({ userId: null, resolvedCount: 0 });
  const resolvedCount = progress.userId === userId ? progress.resolvedCount : 0;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void unresolvedConflicts(userId).then((rows) => {
        if (!cancelled && generation === current) {
          setConflicts(rows); setLoadedUser(userId); setError(null);
          if (!rows.length) setProgress({ userId, resolvedCount: 0 });
        }
      }).catch((cause: unknown) => {
        if (!cancelled && generation === current) {
          setError((cause as Error).message || 'Не удалось прочитать локальные конфликты.');
          setLoadedUser(userId);
        }
      });
    };
    refresh();
    const unsubscribe = subscribeConflictChanges((changedUserId) => { if (changedUserId === userId) refresh(); });
    return () => { cancelled = true; unsubscribe(); };
  }, [userId]);

  const blocked = Boolean(userId && (loadedUser !== userId || conflicts.length || error));
  useEffect(() => {
    if (!blocked) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => true);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
    };
    if (typeof window !== 'undefined') window.addEventListener('keydown', escape, true);
    return () => { back.remove(); if (typeof window !== 'undefined') window.removeEventListener('keydown', escape, true); };
  }, [blocked]);

  if (!userId) return children;
  if (loadedUser !== userId) return <LoadingScreen text="Проверка синхронизации..." />;
  if (error && !conflicts.length) return <View style={styles.screen}><ThemedText>{error}</ThemedText>
    <Button onPress={() => { setError(null); setLoadedUser(null); void unresolvedConflicts(userId).then((rows) => {
      setConflicts(rows); setLoadedUser(userId);
    }).catch((cause: unknown) => { setError((cause as Error).message); setLoadedUser(userId); }); }}>Повторить</Button></View>;
  if (!conflicts.length) return children;
  const conflict = conflicts[0];
  const act = async (choice: 'mine' | 'server') => {
    if (busy || conflict.user_id !== userId) return;
    setBusy(true); setError(null);
    try {
      if (choice === 'mine') await chooseMine(userId, conflict.conflict_id);
      else {
        await chooseServer(userId, conflict.conflict_id);
        void syncPendingOperations(userId).catch(() => undefined);
      }
      const remaining = await unresolvedConflicts(userId);
      setConflicts(remaining);
      setProgress({ userId, resolvedCount: remaining.length ? resolvedCount + 1 : 0 });
    } catch (cause) { setError((cause as Error).message || 'Не удалось разрешить конфликт.'); }
    finally { setBusy(false); }
  };
  return <Gate conflict={conflict} index={resolvedCount} total={resolvedCount + conflicts.length} busy={busy} error={error}
    onMine={() => void act('mine')} onServer={() => void act('server')} />;
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 720, borderWidth: 1, borderRadius: 16, padding: 24, gap: 16 },
  comparison: { flexDirection: 'row', flexWrap: 'wrap', gap: 20 },
  column: { flex: 1, minWidth: 220, gap: 8 },
  value: { gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
});
