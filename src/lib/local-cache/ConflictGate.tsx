import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BackHandler, ScrollView, StyleSheet, View } from 'react-native';
import { useAuth } from '@/features/auth/AuthProvider';
import { Button } from '@/components/ui/button';
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
  const { colors } = useTheme();
  const userId = state.isLoading ? null : state.user?.id ?? null;
  const [loaded, setLoaded] = useState<{ userId: string; conflicts: SyncConflict[] } | null>(null);
  const conflicts = loaded?.userId === userId ? loaded.conflicts : [];
  const readGeneration = useRef(0);
  const activeUser = useRef<string | null>(null);
  const refreshConflicts = useRef<(() => void) | null>(null);
  const appRef = useRef<View>(null);
  const [progress, setProgress] = useState<{ userId: string | null; resolvedCount: number }>({ userId: null, resolvedCount: 0 });
  const resolvedCount = progress.userId === userId ? progress.resolvedCount : 0;
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const busy = busyUser === userId && userId !== null;
  const [actionError, setActionError] = useState<{ userId: string; text: string } | null>(null);
  const error = actionError?.userId === userId ? actionError.text : null;

  useEffect(() => {
    activeUser.current = userId;
    if (!userId) return;
    let cancelled = false;
    const refresh = () => {
      const current = ++readGeneration.current;
      void unresolvedConflicts(userId).then((rows) => {
        if (!cancelled && readGeneration.current === current) {
          setLoaded({ userId, conflicts: rows });
          if (!rows.length) setProgress({ userId, resolvedCount: 0 });
        }
      }).catch(() => {
        if (!cancelled && readGeneration.current === current && process.env.NODE_ENV !== 'production')
          console.warn('[TaskTrace] Не удалось прочитать локальные конфликты.');
      });
    };
    refreshConflicts.current = refresh;
    refresh();
    const unsubscribe = subscribeConflictChanges((changedUserId) => { if (changedUserId === userId) refresh(); });
    return () => { cancelled = true; activeUser.current = null; refreshConflicts.current = null; readGeneration.current += 1; unsubscribe(); };
  }, [userId]);

  const blocked = Boolean(userId && conflicts.length > 0);
  useEffect(() => {
    // Keep the mounted app out of the web keyboard focus order during a real conflict.
    if (typeof HTMLElement !== 'undefined' && appRef.current instanceof HTMLElement)
      appRef.current.inert = blocked;
  }, [blocked]);
  useEffect(() => {
    if (!blocked) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => true);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
    };
    if (typeof window !== 'undefined') window.addEventListener('keydown', escape, true);
    return () => { back.remove(); if (typeof window !== 'undefined') window.removeEventListener('keydown', escape, true); };
  }, [blocked]);

  const app = <View ref={appRef} style={styles.app} pointerEvents={blocked ? 'none' : 'auto'}
    accessibilityElementsHidden={blocked} importantForAccessibility={blocked ? 'no-hide-descendants' : 'auto'}>{children}</View>;
  if (!userId || !conflicts.length) return app;
  const conflict = conflicts[0];
  const act = async (choice: 'mine' | 'server') => {
    if (busy || conflict.user_id !== userId) return;
    setBusyUser(userId); setActionError(null);
    try {
      if (choice === 'mine') await chooseMine(userId, conflict.conflict_id);
      else {
        await chooseServer(userId, conflict.conflict_id);
        void syncPendingOperations(userId, true).catch(() => undefined);
      }
      if (activeUser.current !== userId) return;
      // Resolution is already durable. Do not keep this conflict on screen if a subsequent read fails.
      readGeneration.current += 1;
      setLoaded((previous) => previous?.userId === userId
        ? { userId, conflicts: previous.conflicts.filter((row) => row.conflict_id !== conflict.conflict_id) } : previous);
      setProgress({ userId, resolvedCount: conflicts.length > 1 ? resolvedCount + 1 : 0 });
      refreshConflicts.current?.();
    } catch (cause) { setActionError({ userId, text: (cause as Error).message || 'Не удалось разрешить конфликт.' }); }
    finally { setBusyUser((previous) => previous === userId ? null : previous); }
  };
  return <>{app}<View style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: colors.background }]}>
    <Gate conflict={conflict} index={resolvedCount} total={resolvedCount + conflicts.length} busy={busy} error={error}
      onMine={() => void act('mine')} onServer={() => void act('server')} />
  </View></>;
}

const styles = StyleSheet.create({
  app: { flex: 1 },
  overlay: { zIndex: 1000 },
  screen: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 720, borderWidth: 1, borderRadius: 16, padding: 24, gap: 16 },
  comparison: { flexDirection: 'row', flexWrap: 'wrap', gap: 20 },
  column: { flex: 1, minWidth: 220, gap: 8 },
  value: { gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
});
