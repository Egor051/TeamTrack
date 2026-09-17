import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Screen } from "@/components/ui/screen";
import { PageHeader } from "@/components/ui/page-header";
import { ThemedText } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { TaskStatus } from "@/components/ui/task-status";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { ErrorMessage } from "@/components/ui/error-message";
import {
  getProject,
  listTasksWithStats,
  archiveProject,
  hardDeleteProject,
  restoreProject,
  updateProject,
  type ProjectWithRole,
  type TaskWithStats,
} from "@/features/projects/projects";
import { subscribeMany, type RealtimeEvent, type RealtimeStatus } from "@/lib/supabase/realtime";
import { userMessage } from "@/lib/errors/user-message";
import { layout, spacing } from "@/components/ui/theme";
import { useTheme } from "@/components/ui/theme-provider";
import { useUser } from "@/features/auth/AuthProvider";
import { usePermissionVersion } from "@/features/auth/PermissionProvider";
import { ResourceAccessDeniedError } from "@/lib/errors/domain-errors";
const roleLabels: Record<ProjectWithRole["role"], string> = { owner: "Владелец", admin: "Администратор", member: "Участник", viewer: "Наблюдатель" };

export default function ProjectScreen() {
  const { colors: theme } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const user = useUser();
  const permissionVersion = usePermissionVersion();
  const [project, setProject] = useState<ProjectWithRole | null>(null);
  const [tasks, setTasks] = useState<TaskWithStats[]>([]);
  const [archived, setArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [hardDeleteConfirm, setHardDeleteConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const requestRef = useRef(0);
  const busyRef = useRef(false);
  const loadedProjectIdRef = useRef<string | null>(null);
  const taskIdsRef = useRef<Set<string>>(new Set());
  const realtimeConnectedRef = useRef(false);
  useEffect(() => {
    if (loadedProjectIdRef.current === null || loadedProjectIdRef.current === id) return;
    loadedProjectIdRef.current = null;
    setProject(null);
    setTasks([]);
    setEditing(false);
  }, [id]);
  useEffect(() => {
    taskIdsRef.current = new Set(tasks.map((task) => task.id));
  }, [tasks]);
  const load = useCallback(async () => {
    if (!id) return;
    const request = ++requestRef.current;
    setLoading(true);
    setLoadError("");
    try {
      const nextProject = await getProject(id);
      const nextArchived = nextProject.status === "archived" ? true : archived;
      if (request !== requestRef.current) return;
      loadedProjectIdRef.current = id;
      setProject(nextProject);
      setEditName(nextProject.name);
      setEditDescription(nextProject.description || "");
      if (nextArchived !== archived) setArchived(nextArchived);
      const nextTasks = await listTasksWithStats(id, nextArchived);
      if (request !== requestRef.current) return;
      setTasks(nextTasks);
    } catch (e) {
      if (request === requestRef.current) {
        if (loadedProjectIdRef.current !== id) {
          setProject(null);
          setTasks([]);
        }
        setLoadError(userMessage(e, "Не удалось обновить проект."));
      }
      if (request === requestRef.current && e instanceof ResourceAccessDeniedError) {
        loadedProjectIdRef.current = null;
        setProject(null);
        setTasks([]);
        router.replace("/projects" as never);
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [id, archived]);
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
      if (!id) return;
      void permissionVersion;
      realtimeConnectedRef.current = false;
      const onStatus = (next: RealtimeStatus) => {
        setStatus(next);
        if (next === "connected" && !realtimeConnectedRef.current) {
          realtimeConnectedRef.current = true;
          void load();
        } else if (next !== "connected") {
          realtimeConnectedRef.current = false;
        }
      };
      const specs = [
        {
          table: "tasks",
          options: {
            projectId: id,
            onEvent: () => void load(),
            onStatus,
          },
        },
        {
          table: "project_members",
          options: {
            projectId: id,
            onEvent: () => void load(),
            onStatus,
          },
        },
        {
          table: "task_items",
          options: {
            onEvent: (event: RealtimeEvent) => {
              const taskId = String(event.new.task_id ?? event.old.task_id ?? "");
              if (taskIdsRef.current.has(taskId)) void load();
            },
            onStatus,
          },
        },
      ];
      return subscribeMany(specs);
    }, [id, load, permissionVersion]),
  );
  async function archive() {
    if (busyRef.current) return;
    setActionError("");
    busyRef.current = true;
    setBusy(true);
    try {
      await archiveProject(id!);
      setConfirm(false);
      router.replace("/projects" as never);
    } catch (e) {
      setActionError(userMessage(e, "Не удалось архивировать проект."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function restore() {
    if (busyRef.current) return;
    setActionError("");
    busyRef.current = true;
    setBusy(true);
    try {
      await restoreProject(id!);
      router.replace("/projects" as never);
    } catch (e) {
      setActionError(userMessage(e, "Не удалось восстановить проект."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function hardDelete() { if (busyRef.current) return; setActionError(''); busyRef.current = true; setBusy(true); try { await hardDeleteProject(id!); setHardDeleteConfirm(false); router.replace('/projects' as never); } catch (e) { setActionError(userMessage(e, 'Не удалось удалить проект навсегда.')); } finally { busyRef.current = false; setBusy(false); } }
  async function save() {
    if (busyRef.current) return;
    const nextName = editName.trim();
    if (!nextName) { setActionError('Введите название проекта.'); return; }
    setActionError("");
    busyRef.current = true;
    setBusy(true);
    try {
      await updateProject(id!, nextName, editDescription.trim());
      setEditing(false);
      await load();
    } catch (e) {
      setActionError(userMessage(e, "Не удалось сохранить проект."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const { width } = useWindowDimensions();
  const wide = width >= layout.desktopBreakpoint;
  const showArchivedTasks = project?.status === "archived" ? true : archived;
  const canCreateTask =
    !showArchivedTasks && project?.status === "active" && project.role !== "viewer";
  const complete = tasks.reduce((n, t) => n + t.completedCount, 0),
    total = tasks.reduce((n, t) => n + t.itemCount, 0),
    percent = total ? tasks.reduce((n, t) => n + t.progressPercent * t.itemCount, 0) / total : 0;
  return (
    <Screen padded={false} centerContent={false}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={load}
            tintColor={theme.primary}
          />
        }
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <PageHeader
          title={editing ? "Редактирование проекта" : project?.name || "Проект"}
          subtitle={editing ? "" : project?.description || "Рабочее пространство проекта"}
          breadcrumbs={[{ label: "Проекты", href: "/projects" }, { label: project?.name || "Проект" }]}
          actions={project ? <>
            <Badge tone={project.status === "archived" ? "neutral" : "primary"}>{roleLabels[project.role]}</Badge>
            <Badge tone={project.status === "archived" ? "neutral" : "success"}>{project.status === "archived" ? "В архиве" : "Активный"}</Badge>
          </> : undefined}
        />
        {project && editing ? (
          <Card>
            <Input
              label="Название проекта"
              value={editName}
              onChangeText={setEditName}
              placeholder="Название проекта"
              disabled={busy}
            />
            <Textarea
              label="Описание проекта"
              value={editDescription}
              onChangeText={setEditDescription}
              placeholder="Описание проекта"
              disabled={busy}
            />
            <View style={styles.actions}>
              <Button onPress={() => void save()} loading={busy} disabled={busy}>
                Сохранить
              </Button>
              <Button
                variant="ghost"
                onPress={() => setEditing(false)}
                disabled={busy}
              >
                Отмена
              </Button>
            </View>
          </Card>
        ) : null}
        {project &&
        (project.role === "owner" || project.role === "admin") &&
        project.status === "active" &&
        !editing ? (
          <View style={styles.actions}>
            <Button variant="outline" disabled={busy} onPress={() => setEditing(true)}>
              Редактировать
            </Button>
            <Button variant="destructive" disabled={busy} onPress={() => setConfirm(true)}>
              Архивировать проект
            </Button>
          </View>
        ) : null}
        {project &&
        (project.role === "owner" || project.role === "admin") &&
        project.status === "archived" ? (
          <View style={styles.actions}><Button onPress={() => void restore()} loading={busy} disabled={busy}>Восстановить проект</Button>{project.role === 'owner' ? <Button variant="destructive" onPress={() => setHardDeleteConfirm(true)} disabled={busy}>Удалить навсегда</Button> : null}</View>
        ) : null}
         {loadError && project ? <View style={styles.feedback}><ErrorMessage message={loadError} type="generic" /><Button size="sm" variant="outline" onPress={() => void load()}>Обновить проект</Button></View> : null}
         {actionError ? <ErrorMessage message={actionError} type="validation" /> : null}
         {project ? (
           <Card muted>
            <View style={styles.sectionTitle}>
              <ThemedText type="h2">Обзор проекта</ThemedText>
              <ThemedText type="caption">
                {status === "connected" ? "Данные синхронизированы" : status === "connecting" ? "Подключаемся…" : status === "reconnecting" ? "Переподключаемся…" : "Синхронизация недоступна"}
              </ThemedText>
            </View>
            <Progress
              value={percent}
              label={`${complete} из ${total} пунктов выполнено`}
            />
           </Card>
         ) : null}
         {project?.status === "archived" ? <Card muted><ThemedText type="small">Проект в архиве. Его этапы доступны в архивном списке; владелец или администратор может восстановить их при необходимости.</ThemedText></Card> : null}
         <View style={styles.sectionHead}>
          <ThemedText type="h2">
             {showArchivedTasks ? "Архивные этапы" : "Этапы"} ({tasks.length})
          </ThemedText>
          <View style={styles.actions}>
            {canCreateTask ? (
              <Button
                size="sm"
                disabled={busy}
                onPress={() =>
                  router.push(`/projects/${id}/tasks/new` as never)
                }
              >
                Новый этап
              </Button>
            ) : null}
            {project ? <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onPress={() => router.push(`/projects/${id}/members` as never)}
            >
              Участники
            </Button> : null}
            {project && project.status !== "archived" ? <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onPress={() => setArchived((v) => !v)}
            >
              {showArchivedTasks ? "Активные" : "Архив"}
            </Button> : null}
          </View>
        </View>
        {loadError && !project ? (
          <ErrorState message={loadError} onRetry={load} />
        ) : loading && !tasks.length ? (
          <LoadingState />
        ) : loadError ? null : !tasks.length ? (
          <EmptyState
             title={showArchivedTasks ? "Архивные этапы пусты" : "Этапов пока нет"}
              description={
                showArchivedTasks
                  ? "Здесь появятся этапы после архивации."
                  : canCreateTask
                    ? "Создайте этап, чтобы команда могла начать работу."
                    : "Участники проекта ещё не добавили этапов."
              }
            actionLabel={canCreateTask ? "Новый этап" : undefined}
            onAction={
              canCreateTask
                ? () => router.push(`/projects/${id}/tasks/new` as never)
                : undefined
            }
          />
        ) : (
          <View style={[styles.list, wide && styles.listWide]}>
            {tasks.map((t) => {
              const p = t.progressPercent;
              return (
                <Card style={wide ? styles.taskCard : undefined}
                  key={t.id}
                  onPress={() =>
                    router.push(`/projects/${id}/tasks/${t.id}` as never)
                  }
                  accessibilityLabel={`Открыть этап ${t.title}`}
                >
                  <View style={styles.taskHead}>
                    <ThemedText type="h3" style={styles.flex}>
                      {t.title}
                    </ThemedText>
                    {user && t.assignees.includes(user.id) ? <Badge tone="primary">Мой этап</Badge> : null}
                    <TaskStatus status={t.status} />
                  </View>
                  {t.description ? (
                    <ThemedText type="small" numberOfLines={2}>
                      {t.description}
                    </ThemedText>
                  ) : null}
                  <Progress
                    value={p}
                    label={`${Math.round(p)}% · ${t.itemCount} пунктов · ${t.assignees.length} исполнителей`}
                  />
                </Card>
              );
            })}
          </View>
        )}
      </ScrollView>
      <ConfirmDialog
        visible={confirm}
        title="Архивировать проект?"
        description="Проект исчезнет из активного списка. Действие можно выполнить только через доступные права проекта."
        confirmLabel="Архивировать"
        busy={busy}
        onCancel={() => setConfirm(false)}
        onConfirm={() => void archive()}
      />
      <ConfirmDialog visible={hardDeleteConfirm} title="Удалить проект навсегда?" description="Проект, архивные этапы и связанные данные будут удалены без возможности восстановления." confirmLabel="Удалить навсегда" busy={busy} onCancel={() => setHardDeleteConfirm(false)} onConfirm={() => void hardDelete()} />
    </Screen>
  );
}
const styles = StyleSheet.create({
  content: {
    width: "100%",
    maxWidth: layout.appMaxWidth,
    alignSelf: "center",
    padding: spacing.xl,
    gap: spacing.xl,
  },
  sectionTitle: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  sectionHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.lg,
  },
  feedback: { gap: spacing.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  list: { gap: spacing.md },
  listWide: { flexDirection: "row", flexWrap: "wrap" },
  taskCard: { flexBasis: "48%", flexGrow: 1 },
  taskHead: { flexDirection: "row", alignItems: "flex-start", flexWrap: "wrap", gap: spacing.md },
  flex: { flex: 1, minWidth: 0 },
});
