import { useCallback, useRef, useState } from "react";
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
  getProject,
  listProjectDailyProgress,
  type ProjectDailyProgress,
} from "@/features/projects/projects";
import { subscribeMany, type RealtimeStatus } from "@/lib/supabase/realtime";
import { userMessage } from "@/lib/errors/user-message";
import { layout, spacing } from "@/components/ui/theme";
import { useTheme } from "@/components/ui/theme-provider";
import { usePermissionVersion } from "@/features/auth/PermissionProvider";
import { ResourceAccessDeniedError } from "@/lib/errors/domain-errors";

export default function ProjectDailyProgressScreen() {
  const { colors: theme } = useTheme();
  const { width } = useWindowDimensions();
  const compact = width < 700;
  const { id } = useLocalSearchParams<{ id: string }>();
  const permissionVersion = usePermissionVersion();
  const [projectName, setProjectName] = useState("");
  const [progress, setProgress] = useState<ProjectDailyProgress | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const requestRef = useRef(0);
  const realtimeConnectedRef = useRef(false);

  const load = useCallback(async () => {
    if (!id) return;
    const request = ++requestRef.current;
    setLoading(true);
    setError("");
    try {
      const [project, dailyProgress] = await Promise.all([
        getProject(id),
        listProjectDailyProgress(id),
      ]);
      if (request !== requestRef.current) return;
      setProjectName(project.name);
      setProgress(dailyProgress);
      setLoaded(true);
    } catch (e) {
      if (request !== requestRef.current) return;
      setError(userMessage(e, "Не удалось загрузить прогресс дня."));
      if (e instanceof ResourceAccessDeniedError) {
        setProgress(null);
        setLoaded(false);
        router.replace("/projects" as never);
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void permissionVersion;
      void load();
      return () => { requestRef.current += 1; };
    }, [load, permissionVersion]),
  );

  useFocusEffect(
    useCallback(() => {
      if (!id) return;
      void permissionVersion;
      const onEvent = () => void load();
      const onStatus = (next: RealtimeStatus) => {
        setStatus(next);
        if (next === "connected" && !realtimeConnectedRef.current) {
          realtimeConnectedRef.current = true;
          void load();
        } else if (next !== "connected") {
          realtimeConnectedRef.current = false;
        }
      };
      return subscribeMany([
        { table: "audit_log", options: { projectId: id, onEvent, onStatus } },
        { table: "tasks", options: { projectId: id, onEvent, onStatus } },
      ]);
    }, [id, load, permissionVersion]),
  );

  const hasProgress = Boolean(progress?.entries.length);
  return (
    <Screen padded={false} centerContent={false}>
      <ScrollView
        contentContainerStyle={[styles.content, compact && styles.compactContent]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={theme.primary} />}
      >
        <PageHeader
          title="Прогресс дня"
          subtitle={projectName || "Только сегодняшние увеличения прогресса"}
          onBack={() => router.replace(`/projects/${id}` as never)}
          backLabel="К проекту"
          breadcrumbs={[{ label: "Проекты", href: "/projects" }, { label: projectName || "Проект", href: `/projects/${id}` }, { label: "Прогресс дня" }]}
          actions={<><RealtimeIndicator status={status} /><Button size="sm" variant="outline" loading={loading} disabled={loading} onPress={() => void load()}>Обновить</Button></>}
        />
        {error && loaded ? <View style={styles.feedback}><ErrorMessage message={error} type="generic" /><Button size="sm" variant="outline" onPress={() => void load()}>Обновить прогресс</Button></View> : null}
        {error && !loaded ? (
          <ErrorState message={error} onRetry={load} />
        ) : loading && !loaded ? (
          <LoadingState label="Загружаем прогресс дня..." />
        ) : !hasProgress ? (
          <EmptyState title="Прогресс дня" description="Сегодня ещё не было увеличений прогресса." />
        ) : progress ? (
          <View style={styles.tables}>
            <View style={styles.tableBlock}>
              <ThemedText type="small">Здесь каждому отображаемому этапу сопоставлен порядковый номер для второй таблицы.</ThemedText>
              <View style={[styles.table, { borderColor: theme.border }]}>
                <View style={[styles.row, styles.headerRow, { backgroundColor: theme.surfaceMuted, borderBottomColor: theme.border }]}>
                  <View style={[styles.cell, styles.stageCell, { borderRightColor: theme.border }]}><ThemedText type="small" style={styles.headerText}>Проект</ThemedText></View>
                  <View style={[styles.cell, styles.numberCell]}><ThemedText type="small" style={styles.headerText}>Порядковый номер</ThemedText></View>
                </View>
                {progress.stages.map((stage, index) => (
                  <View key={stage.taskId} style={[styles.row, index < progress.stages.length - 1 && { borderBottomColor: theme.border, borderBottomWidth: 1 }]}>
                    <View style={[styles.cell, styles.stageCell, { borderRightColor: theme.border }]}><ThemedText>{stage.title}</ThemedText></View>
                    <View style={[styles.cell, styles.numberCell]}><ThemedText>{stage.stageNumber}</ThemedText></View>
                  </View>
                ))}
              </View>
            </View>
            <View style={styles.tableBlock}>
              <ThemedText type="small">Здесь показаны пункты этапов, которые вы изменяли сегодня. Столбец «Проект» содержит номер этапа из первой таблицы.</ThemedText>
              <View style={[styles.table, { borderColor: theme.border }]}>
                <View style={[styles.row, styles.headerRow, { backgroundColor: theme.surfaceMuted, borderBottomColor: theme.border }]}>
                  <View style={[styles.cell, styles.projectCell, { borderRightColor: theme.border }]}><ThemedText type="small" style={styles.headerText}>Проект</ThemedText></View>
                  <View style={[styles.cell, styles.itemCell, { borderRightColor: theme.border }]}><ThemedText type="small" style={styles.headerText}>Пункт</ThemedText></View>
                  <View style={[styles.cell, styles.statusCell]}><ThemedText type="small" style={styles.headerText}>Статус</ThemedText></View>
                </View>
                {progress.entries.map((entry, index) => {
                  const completed = entry.newPercentage === 100;
                  return (
                    <View key={`${entry.taskId}-${entry.taskItemId}`} style={[styles.row, index < progress.entries.length - 1 && { borderBottomColor: theme.border, borderBottomWidth: 1 }]}>
                      <View style={[styles.cell, styles.projectCell, { borderRightColor: theme.border }]}><ThemedText>{entry.stageNumber}</ThemedText></View>
                      <View style={[styles.cell, styles.itemCell, { borderRightColor: theme.border }]}><ThemedText>{entry.title}</ThemedText></View>
                      <View style={[styles.cell, styles.statusCell, completed && styles.completedCell]}><ThemedText style={completed ? styles.completedText : undefined}>{completed ? "Выполнен" : `Выполнен частично: ${entry.oldPercentage}% → ${entry.newPercentage}%`}</ThemedText></View>
                    </View>
                  );
                })}
              </View>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { width: "100%", maxWidth: layout.readingMaxWidth, alignSelf: "center", padding: spacing.xl, gap: spacing.lg },
  compactContent: { padding: spacing.lg },
  feedback: { gap: spacing.sm },
  tables: { gap: spacing.lg },
  tableBlock: { gap: spacing.sm },
  table: { width: "100%", borderWidth: 1 },
  row: { flexDirection: "row", width: "100%", minHeight: 56 },
  headerRow: { minHeight: 48, borderBottomWidth: 1 },
  cell: { justifyContent: "center", paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  stageCell: { flex: 2, borderRightWidth: 1 },
  numberCell: { flex: 1, borderRightWidth: 1 },
  projectCell: { width: 80, flexGrow: 0, flexShrink: 0, borderRightWidth: 1 },
  itemCell: { flex: 2, borderRightWidth: 1 },
  statusCell: { flex: 2 },
  headerText: { fontWeight: "700" },
  completedCell: { backgroundColor: "#16835D" },
  completedText: { color: "#FFFFFF", fontWeight: "700" },
});
