import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
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
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
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
const roleLabels: Record<ProjectWithRole["role"], string> = { owner: "Владелец", admin: "Администратор", member: "Участник", viewer: "Наблюдатель" };

export default function ProjectScreen() {
  const { colors: theme } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const user = useUser();
  const [project, setProject] = useState<ProjectWithRole | null>(null);
  const [tasks, setTasks] = useState<TaskWithStats[]>([]);
  const [archived, setArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [hardDeleteConfirm, setHardDeleteConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const requestRef = useRef(0);
  const taskIdsRef = useRef<Set<string>>(new Set());
  const realtimeConnectedRef = useRef(false);
  useEffect(() => {
    taskIdsRef.current = new Set(tasks.map((task) => task.id));
  }, [tasks]);
  const load = useCallback(async () => {
    if (!id) return;
    const request = ++requestRef.current;
    setLoading(true);
    setError("");
    try {
      const [nextProject, nextTasks] = await Promise.all([
        getProject(id),
        listTasksWithStats(id, archived),
      ]);
      if (request !== requestRef.current) return;
      setProject(nextProject);
      setEditName(nextProject.name);
      setEditDescription(nextProject.description || "");
      setTasks(nextTasks);
    } catch (e) {
      if (request === requestRef.current)
        setProject(null);
      if (request === requestRef.current)
        setTasks([]);
      if (request === requestRef.current)
        setError(userMessage(e, "Не удалось загрузить проект."));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [id, archived]);
  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        requestRef.current += 1;
      };
    }, [load]),
  );
  useFocusEffect(
    useCallback(() => {
      if (!id) return;
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
    }, [id, load]),
  );
  async function archive() {
    setBusy(true);
    try {
      await archiveProject(id!);
      setConfirm(false);
      router.replace("/projects" as never);
    } catch (e) {
      setError(userMessage(e, "Не удалось архивировать проект."));
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    setBusy(true);
    try {
      await restoreProject(id!);
      router.replace("/projects" as never);
    } catch (e) {
      setError(userMessage(e, "Не удалось восстановить проект."));
    } finally {
      setBusy(false);
    }
  }
  async function hardDelete() { setBusy(true); try { await hardDeleteProject(id!); setHardDeleteConfirm(false); router.replace('/projects' as never); } catch (e) { setError(userMessage(e, 'Не удалось удалить проект навсегда.')); } finally { setBusy(false); } }
  async function save() {
    setBusy(true);
    try {
      await updateProject(id!, editName, editDescription);
      setEditing(false);
      await load();
    } catch (e) {
      setError(userMessage(e, "Не удалось сохранить проект."));
    } finally {
      setBusy(false);
    }
  }
  const canCreateTask =
    !archived && project?.status === "active" && project.role !== "viewer";
  const complete = tasks.reduce((n, t) => n + t.completedCount, 0),
    total = tasks.reduce((n, t) => n + t.itemCount, 0),
    percent = total ? (complete / total) * 100 : 0;
  return (
    <Screen padded={false} centerContent={false}>
      <ScrollView
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
        {project ? (
          <PageHeader
            title={editing ? "Редактирование проекта" : project.name}
            subtitle={
              editing
                ? ""
                : project.description || "Рабочее пространство проекта"
            }
            onBack={() => router.back()}
            actions={
              <>
                <Badge
                  tone={project.status === "archived" ? "neutral" : "primary"}
                >
                  {roleLabels[project.role]}
                </Badge>
                <Badge
                  tone={project.status === "archived" ? "neutral" : "success"}
                >
                  {project.status === "archived" ? "В архиве" : "Активный"}
                </Badge>
              </>
            }
          />
        ) : null}
        {project && editing ? (
          <Card>
            <Input
              value={editName}
              onChangeText={setEditName}
              placeholder="Название проекта"
            />
            <Textarea
              value={editDescription}
              onChangeText={setEditDescription}
              placeholder="Описание проекта"
            />
            <View style={styles.actions}>
              <Button onPress={() => void save()} disabled={busy}>
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
        {project ? (
          <Card>
            <View style={styles.sectionTitle}>
              <ThemedText type="h2">Обзор проекта</ThemedText>
              <ThemedText type="caption">
                Синхронизация: {status === "connected" ? "готова" : status}
              </ThemedText>
            </View>
            <Progress
              value={percent}
              label={`${complete} из ${total} пунктов выполнено`}
            />
          </Card>
        ) : null}
        <View style={styles.sectionHead}>
          <ThemedText type="h2">
            {archived ? "Архивные задачи" : "Задачи"} ({tasks.length})
          </ThemedText>
          <View style={styles.actions}>
            {canCreateTask ? (
              <Button
                size="sm"
                onPress={() =>
                  router.push(`/projects/${id}/tasks/new` as never)
                }
              >
                Новая задача
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onPress={() => router.push(`/projects/${id}/members` as never)}
            >
              Участники
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onPress={() => setArchived((v) => !v)}
            >
              {archived ? "Активные" : "Архив"}
            </Button>
          </View>
        </View>
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : loading && !project ? (
          <LoadingState />
        ) : !tasks.length ? (
          <EmptyState
            title={archived ? "Архивные задачи пусты" : "Задач пока нет"}
            description={
              archived
                ? "Здесь появятся задачи после архивации."
                : "Создайте задачу, чтобы команда могла начать работу."
            }
            actionLabel={canCreateTask ? "Новая задача" : undefined}
            onAction={
              canCreateTask
                ? () => router.push(`/projects/${id}/tasks/new` as never)
                : undefined
            }
          />
        ) : (
          <View style={styles.list}>
            {tasks.map((t) => {
              const p = t.itemCount
                ? (t.completedCount / t.itemCount) * 100
                : 0;
              return (
                <Card
                  key={t.id}
                  onPress={() =>
                    router.push(`/projects/${id}/tasks/${t.id}` as never)
                  }
                  accessibilityLabel={`Открыть задачу ${t.title}`}
                >
                  <View style={styles.taskHead}>
                    <ThemedText type="h3" style={styles.flex}>
                      {t.title}
                    </ThemedText>
                    {user && t.assignees.includes(user.id) ? <Badge tone="primary">Моя задача</Badge> : null}
                    <Badge
                      tone={
                        t.status === "completed"
                          ? "success"
                          : t.status === "archived"
                            ? "neutral"
                            : "primary"
                      }
                    >
                      {t.status === "not_started"
                        ? "Не начата"
                        : t.status === "in_progress"
                          ? "В работе"
                          : t.status === "completed"
                            ? "Завершена"
                            : "В архиве"}
                    </Badge>
                  </View>
                  {t.description ? (
                    <ThemedText type="small" numberOfLines={2}>
                      {t.description}
                    </ThemedText>
                  ) : null}
                  <Progress
                    value={p}
                    label={`${t.completedCount}/${t.itemCount} пунктов · ${t.assignees.length} исполнителей`}
                  />
                </Card>
              );
            })}
          </View>
        )}
        {project &&
        (project.role === "owner" || project.role === "admin") &&
        project.status === "active" &&
        !editing ? (
          <View style={styles.actions}>
            <Button variant="outline" onPress={() => setEditing(true)}>
              Редактировать
            </Button>
            <Button variant="destructive" onPress={() => setConfirm(true)}>
              Архивировать проект
            </Button>
          </View>
        ) : null}
        {project &&
        (project.role === "owner" || project.role === "admin") &&
        project.status === "archived" ? (
          <View style={styles.actions}><Button onPress={() => void restore()} disabled={busy}>Восстановить проект</Button>{project.role === 'owner' ? <Button variant="destructive" onPress={() => setHardDeleteConfirm(true)} disabled={busy}>Удалить навсегда</Button> : null}</View>
        ) : null}
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
      <ConfirmDialog visible={hardDeleteConfirm} title="Удалить проект навсегда?" description="Проект, архивные задачи и связанные данные будут удалены без возможности восстановления." confirmLabel="Удалить навсегда" busy={busy} onCancel={() => setHardDeleteConfirm(false)} onConfirm={() => void hardDelete()} />
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
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  list: { gap: spacing.md },
  taskHead: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  flex: { flex: 1 },
});
