import { isReadAccessPending } from '@/lib/local-cache/read-freshness';
import { useReadModelUpdates } from '@/lib/local-cache/use-read-model-updates';
import { useOnlineRecovery } from '@/lib/connectivity/use-online-recovery';
import { useCurrentDay } from '@/lib/local-cache/use-current-day';
import { useCallback, useRef, useState } from "react";
import { DailyProgressRow } from '@/features/projects/daily-progress-row';
import { RefreshControl, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useFocusEffect, useLocalSearchParams, router } from "expo-router";
import { Screen } from "@/components/ui/screen";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { ThemedText } from "@/components/ui/text";
import { RealtimeIndicator } from "@/components/ui/realtime-indicator";
import { ErrorMessage } from "@/components/ui/error-message";
import {
  getTaskProjectContext,
  getTask,
  listTaskDailyProgress,
  type DailyProgressEntry,
} from "@/features/projects/projects";
import { subscribeMany, type RealtimeStatus } from "@/lib/supabase/realtime";
import { userMessage } from "@/lib/errors/user-message";
import { layout, spacing } from "@/components/ui/theme";
import { useTheme } from "@/components/ui/theme-provider";
import { usePermissionVersion } from "@/features/auth/PermissionProvider";
import { ResourceAccessDeniedError } from "@/lib/errors/domain-errors";

export default function DailyProgress() {
  const { colors: theme } = useTheme();
  const { width } = useWindowDimensions();
  const [contentWidth, setContentWidth] = useState<number | null>(null);
  const compact = (contentWidth ?? width) < 700;
  const { id, taskId } = useLocalSearchParams<{ id: string; taskId: string }>();
  const permissionVersion = usePermissionVersion();
  const [taskTitle, setTaskTitle] = useState("");
  const [projectName, setProjectName] = useState("");
  const [projectAccessible, setProjectAccessible] = useState(false);
  const day = useCurrentDay();
  const [loadedDay, setLoadedDay] = useState(day);
  const [storedProgress, setProgress] = useState<DailyProgressEntry[]>([]);
  const progress = loadedDay === day ? storedProgress : [];
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const requestRef = useRef(0);
  const realtimeConnectedRef = useRef(false);

  const load = useCallback(async () => {
    if (!id || !taskId) return;
    if (isReadAccessPending(`task:${taskId}`)) { setProgress([]); setLoaded(false); }
    const request = ++requestRef.current;
    setLoading(true);
    setError("");
    try {
      const [task, project, dailyProgress] = await Promise.all([
        getTask(taskId, id),
        getTaskProjectContext(taskId),
        listTaskDailyProgress(id, taskId),
      ]);
      if (request !== requestRef.current) return;
      setTaskTitle(task.title);
      setProjectName(project.name);
      setProjectAccessible(!!project.role);
      setProgress(dailyProgress);
      setLoadedDay(day);
      setLoaded(true);
    } catch (e) {
      if (request !== requestRef.current) return;
      setError(userMessage(e, "Не удалось загрузить прогресс дня."));
      if (e instanceof ResourceAccessDeniedError) {
        setProgress([]);
        setLoaded(false);
        router.replace("/projects" as never);
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [id, taskId, day]);

  const { scheduleRefresh, refreshFromServer } = useReadModelUpdates(load, { projectId: id, taskId });
  useOnlineRecovery(load);
  useFocusEffect(
    useCallback(() => {
      void permissionVersion;
      void load();
      return () => {
        requestRef.current += 1;
      };
    }, [load, permissionVersion]),
  );

  useFocusEffect(
    useCallback(() => {
      if (!id || !taskId) return;
      void permissionVersion;
      const onEvent = scheduleRefresh;
      const onStatus = (next: RealtimeStatus) => {
        setStatus(next);
        if (next === "connected" && !realtimeConnectedRef.current) {
          realtimeConnectedRef.current = true;
          scheduleRefresh();
        } else if (next !== "connected") {
          realtimeConnectedRef.current = false;
        }
      };
      return subscribeMany([
        { table: "projects", options: { taskId, onEvent, onStatus } },
        { table: "task_items", options: { taskId, onEvent, onStatus } },
        { table: "tasks", options: { taskId, onEvent, onStatus } },
      ]);
    }, [id, taskId, permissionVersion, scheduleRefresh]),
  );

  return (
    <Screen padded={false} centerContent={false}>
      <ScrollView
        contentContainerStyle={[styles.content, width < 700 && styles.compactContent]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refreshFromServer()} tintColor={theme.primary} />}
      >
        <PageHeader
          title="Прогресс дня"
          subtitle={taskTitle || "Только сегодняшние увеличения прогресса"}
          onBack={() => router.dismissTo(`/projects/${id}/tasks/${taskId}` as never)}
          backLabel="К этапу"
          breadcrumbs={[{ label: "Проекты", href: "/projects" }, { label: projectName || "Проект", ...(projectAccessible ? { href: `/projects/${id}` } : {}) }, { label: taskTitle || "Этап", href: `/projects/${id}/tasks/${taskId}` }, { label: "Прогресс дня" }]}
          actions={<><RealtimeIndicator status={status} /><Button size="sm" variant="outline" loading={loading} disabled={loading} onPress={() => void refreshFromServer()}>Обновить</Button></>}
        />
        {error && loaded ? <View style={styles.feedback}><ErrorMessage message={error} type="generic" /><Button size="sm" variant="outline" onPress={() => void refreshFromServer()}>Обновить прогресс</Button></View> : null}
        {error && !loaded ? (
          <ErrorState message={error} onRetry={refreshFromServer} />
        ) : loading && !loaded ? (
          <LoadingState label="Загружаем прогресс дня..." />
        ) : !progress.length ? (
          <EmptyState title="Прогресс дня" description="Сегодня ещё не было увеличений прогресса." />
        ) : (
          <View testID="daily-progress-content" onLayout={event => setContentWidth(event.nativeEvent.layout.width)}>
          {compact ? <View style={styles.feedback}>{progress.map(entry => <DailyProgressRow key={entry.taskItemId}
            title={entry.title} completed={entry.newPercentage === 100}
            status={entry.newPercentage === 100 ? 'Выполнен' : `Выполнен частично: ${entry.oldPercentage}% → ${entry.newPercentage}%`} />)}</View> : <View style={[styles.table, { borderColor: theme.border }]}>
            <View style={[styles.row, styles.headerRow, { backgroundColor: theme.surfaceMuted, borderBottomColor: theme.border }]}>
              <View style={[styles.cell, styles.itemCell, { borderRightColor: theme.border }]}><ThemedText type="small" style={styles.headerText}>Пункт</ThemedText></View>
              <View style={[styles.cell, styles.statusCell]}><ThemedText type="small" style={styles.headerText}>Статус</ThemedText></View>
            </View>
            {progress.map((entry, index) => {
              const completed = entry.newPercentage === 100;
              return (
                <View key={entry.taskItemId} style={[styles.row, index < progress.length - 1 && { borderBottomColor: theme.border, borderBottomWidth: 1 }]}>
                  <View style={[styles.cell, styles.itemCell, { borderRightColor: theme.border }]}><ThemedText>{entry.title}</ThemedText></View>
                  <View style={[styles.cell, styles.statusCell, completed && styles.completedCell]}>
                    <ThemedText numberOfLines={1} style={completed ? styles.completedText : undefined}>
                      {completed ? "Выполнен" : `Выполнен частично: ${entry.oldPercentage}% → ${entry.newPercentage}%`}
                    </ThemedText>
                  </View>
                </View>
              );
            })}
          </View>}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    width: "100%",
    maxWidth: layout.readingMaxWidth,
    alignSelf: "center",
    padding: spacing.xl,
    gap: spacing.lg,
  },
  compactContent: { padding: spacing.lg },
  feedback: { gap: spacing.sm },
  table: { width: "100%", borderWidth: 1 },
  row: { flexDirection: "row", width: "100%", minHeight: 56 },
  headerRow: { minHeight: 48, borderBottomWidth: 1 },
  cell: { justifyContent: "center", paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  itemCell: { flex: 2, borderRightWidth: 1 },
  statusCell: { width: 275, flexGrow: 0, flexShrink: 0 },
  headerText: { fontWeight: "700" },
  completedCell: { backgroundColor: "#16835D" },
  completedText: { color: "#FFFFFF", fontWeight: "700" },
});
