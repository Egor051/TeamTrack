import { useCallback, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Screen } from "@/components/ui/screen";
import { PageHeader } from "@/components/ui/page-header";
import { ThemedText } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { RealtimeIndicator } from "@/components/ui/realtime-indicator";
import { Input } from "@/components/ui/input";
import {
  getTask,
  getProject,
  listTaskItems,
  createTaskItem,
  updateTaskItem,
  archiveTaskItem,
  setTaskItemState,
  listProjectMembers,
  listTaskMembers,
  listTaskAssignees,
  addTaskAssignee,
  removeTaskAssignee,
  approveTaskMember,
  revokeTaskMember,
  archiveTask,
  type Task,
  type TaskItem,
  type ProjectMember,
  type TaskMember,
  type ProjectWithRole,
} from "@/features/projects/projects";
import { subscribeMany, type RealtimeStatus } from "@/lib/supabase/realtime";
import { userMessage } from "@/lib/errors/user-message";
import { colors, layout, spacing } from "@/components/ui/theme";

export default function TaskScreen() {
  const { id, taskId } = useLocalSearchParams<{ id: string; taskId: string }>();
  const [task, setTask] = useState<Task | null>(null);
  const [project, setProject] = useState<ProjectWithRole | null>(null);
  const [items, setItems] = useState<TaskItem[]>([]);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [taskMembers, setTaskMembers] = useState<TaskMember[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    action: () => Promise<unknown>;
  } | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!id || !taskId) return;
    const request = ++requestRef.current;
    try {
      const [
        nextTask,
        nextProject,
        nextItems,
        nextProjectMembers,
        nextTaskMembers,
        nextAssignees,
      ] = await Promise.all([
        getTask(taskId, id),
        getProject(id),
        listTaskItems(taskId),
        listProjectMembers(id),
        listTaskMembers(taskId),
        listTaskAssignees(taskId),
      ]);
      if (request !== requestRef.current) return;
      setTask(nextTask);
      setProject(nextProject);
      setItems(nextItems);
      setProjectMembers(nextProjectMembers);
      setTaskMembers(nextTaskMembers);
      setAssignees(nextAssignees);
      setError("");
    } catch (e) {
      if (request === requestRef.current)
        setError(userMessage(e, "Нет доступа к задаче."));
    }
  }, [id, taskId]);

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
      if (!taskId || !id) return;
      const onEvent = () => {
        void load();
      };
      return subscribeMany([
        {
          table: "task_items",
          options: { taskId, onEvent, onStatus: setStatus },
        },
        {
          table: "task_members",
          options: { taskId, onEvent, onStatus: setStatus },
        },
        {
          table: "task_assignees",
          options: { taskId, onEvent, onStatus: setStatus },
        },
      ]);
    }, [id, taskId, load]),
  );

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(userMessage(e, "Операция не выполнена."));
    } finally {
      setBusy(false);
    }
  }

  async function confirmAction() {
    if (!confirm) return;
    const action = confirm.action;
    setConfirm(null);
    await run(action);
  }

  const canManage =
    (project?.role === "owner" || project?.role === "admin") &&
    project?.status === "active" &&
    task?.status !== "archived";
  const canEdit =
    project?.status === "active" &&
    project.role !== "viewer" &&
    task?.status !== "archived";
  const done = items.filter((item) => item.is_completed).length;

  return (
    <Screen padded={false} centerContent={false}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {task ? (
          <PageHeader
            title={task.title}
            subtitle={task.description || "Рабочая задача"}
            onBack={() => router.back()}
            actions={
              <>
                <RealtimeIndicator status={status} />
                <Badge
                  tone={
                    task.status === "completed"
                      ? "success"
                      : task.status === "archived"
                        ? "neutral"
                        : "primary"
                  }
                >
                  {task.status === "not_started"
                    ? "Не начата"
                    : task.status === "in_progress"
                      ? "В работе"
                      : task.status === "completed"
                        ? "Завершена"
                        : "В архиве"}
                </Badge>
              </>
            }
          />
        ) : null}
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : !task ? (
          <LoadingState label="Загружаем задачу..." />
        ) : (
          <>
            <Card>
              <Progress
                value={items.length ? (done / items.length) * 100 : 0}
                label={`Прогресс · ${done} из ${items.length}`}
              />
            </Card>
            <View style={styles.sectionHead}>
              <ThemedText type="h2">Чек-лист</ThemedText>
              <Button
                size="sm"
                variant="outline"
                onPress={() =>
                  router.push(
                    `/projects/${id}/tasks/${taskId}/history` as never,
                  )
                }
              >
                История
              </Button>
            </View>
            {!items.length ? (
              <EmptyState
                title="Чек-лист пуст"
                description="Добавьте первый пункт, чтобы разбить задачу на последовательные шаги."
              />
            ) : (
              <View style={styles.list}>
                {items.map((item, index) => (
                  <Card key={item.id}>
                    <View style={styles.itemRow}>
                      <Checkbox
                        checked={item.is_completed}
                        disabled={busy || !canEdit}
                        label={`${item.title}, ${item.is_completed ? "выполнено" : "не выполнено"}`}
                        onPress={() =>
                          void run(() =>
                            setTaskItemState(item.id, !item.is_completed),
                          )
                        }
                      />
                      <View style={styles.flex}>
                        {editing === item.id ? (
                          <Input
                            placeholder="Текст пункта"
                            value={editTitle}
                            onChangeText={setEditTitle}
                            autoFocus
                          />
                        ) : (
                          <ThemedText
                            style={
                              item.is_completed ? styles.completed : undefined
                            }
                          >
                            {index + 1}. {item.title}
                          </ThemedText>
                        )}
                      </View>
                    </View>
                    {editing === item.id ? (
                      <View style={styles.actions}>
                        <Button
                          size="sm"
                          disabled={busy || !editTitle.trim()}
                          onPress={() =>
                            void run(async () => {
                              await updateTaskItem(item.id, editTitle.trim());
                              setEditing(null);
                            })
                          }
                        >
                          Сохранить
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onPress={() => setEditing(null)}
                        >
                          Отмена
                        </Button>
                      </View>
                    ) : canEdit ? (
                      <View style={styles.actions}>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onPress={() => {
                            setEditing(item.id);
                            setEditTitle(item.title);
                          }}
                        >
                          Изменить
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onPress={() =>
                            setConfirm({
                              title: "Архивировать пункт?",
                              description:
                                "Пункт исчезнет из активного чек-листа.",
                              action: () => archiveTaskItem(item.id),
                            })
                          }
                        >
                          Архив
                        </Button>
                      </View>
                    ) : null}
                  </Card>
                ))}
              </View>
            )}
            {canEdit ? (
              <View style={styles.addRow}>
                <Input
                  label="Новый пункт"
                  placeholder="Что нужно сделать?"
                  value={title}
                  onChangeText={setTitle}
                />
                <Button
                  disabled={busy || !title.trim()}
                  loading={busy}
                  onPress={() =>
                    void run(async () => {
                      await createTaskItem(taskId, title.trim());
                      setTitle("");
                    })
                  }
                >
                  Добавить пункт
                </Button>
              </View>
            ) : null}
            {canManage ? (
              <>
                <Card>
                  <ThemedText type="h2">Участники задачи</ThemedText>
                  <ThemedText type="small">
                    Кто имеет доступ к этой задаче
                  </ThemedText>
                  {!projectMembers.length ? (
                    <EmptyState
                      title="Участников нет"
                      description="В проекте пока нет доступных участников."
                    />
                  ) : (
                    projectMembers.map((member) => {
                      const access = taskMembers.some(
                        (entry) => entry.user_id === member.user_id,
                      );
                      return (
                        <View key={member.user_id} style={styles.memberRow}>
                          <ThemedText style={styles.flex}>
                            {member.profile?.display_name || member.user_id}
                          </ThemedText>
                          <Badge tone={access ? "success" : "neutral"}>
                            {access ? "Есть доступ" : "Нет доступа"}
                          </Badge>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onPress={() =>
                              setConfirm({
                                title: access
                                  ? "Отозвать доступ?"
                                  : "Одобрить доступ?",
                                description: access
                                  ? "Пользователь больше не сможет открыть задачу."
                                  : "Пользователь получит доступ к задаче.",
                                action: () =>
                                  access
                                    ? revokeTaskMember(taskId, member.user_id)
                                    : approveTaskMember(taskId, member.user_id),
                              })
                            }
                          >
                            {access ? "Отозвать" : "Одобрить"}
                          </Button>
                        </View>
                      );
                    })
                  )}
                </Card>
                <Card>
                  <ThemedText type="h2">Исполнители</ThemedText>
                  <ThemedText type="small">
                    Кто назначен выполнять задачу
                  </ThemedText>
                  {taskMembers.length ? (
                    taskMembers.map((member) => {
                      const assigned = assignees.includes(member.user_id);
                      return (
                        <View key={member.user_id} style={styles.memberRow}>
                          <ThemedText style={styles.flex}>
                            {member.profile?.display_name || member.user_id}
                          </ThemedText>
                          {assigned ? (
                            <Badge tone="primary">Назначен</Badge>
                          ) : null}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onPress={() =>
                              setConfirm({
                                title: assigned
                                  ? "Снять назначение?"
                                  : "Назначить исполнителя?",
                                description: assigned
                                  ? "Пользователь больше не будет отображаться исполнителем."
                                  : "Пользователь появится в списке исполнителей.",
                                action: () =>
                                  assigned
                                    ? removeTaskAssignee(taskId, member.user_id)
                                    : addTaskAssignee(taskId, member.user_id),
                              })
                            }
                          >
                            {assigned ? "Снять" : "Назначить"}
                          </Button>
                        </View>
                      );
                    })
                  ) : (
                    <ThemedText type="small">Нет участников задачи.</ThemedText>
                  )}
                </Card>
                <Button
                  variant="destructive"
                  onPress={() =>
                    setConfirm({
                      title: "Архивировать задачу?",
                      description:
                        "Задача исчезнет из активного списка проекта.",
                      action: () => archiveTask(taskId),
                    })
                  }
                >
                  Архивировать задачу
                </Button>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
      <ConfirmDialog
        visible={Boolean(confirm)}
        title={confirm?.title || ""}
        description={confirm?.description || ""}
        confirmLabel="Подтвердить"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void confirmAction()}
      />
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
  sectionHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.md,
  },
  list: { gap: spacing.md },
  itemRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexWrap: "wrap",
    paddingVertical: spacing.sm,
  },
  flex: { flex: 1, minWidth: 120 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  addRow: { gap: spacing.md },
  completed: { textDecorationLine: "line-through", color: colors.textMuted },
});
