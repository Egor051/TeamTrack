import { useCallback, useRef, useState } from "react";
import { Modal, ScrollView, StyleSheet, View } from "react-native";
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
import { Textarea } from "@/components/ui/textarea";
import {
  getTask,
  getProject,
  listTaskItems,
  createTaskItem,
  updateTaskItem,
  archiveTaskItem,
  hardDeleteTaskItem,
  setTaskItemState,
  setTaskItemPercentage,
  setTaskItemComment,
  updateTask,
  listProjectMembers,
  listTaskMembers,
  listTaskAssignees,
  listTaskItemLastEditors,
  addTaskAssignee,
  removeTaskAssignee,
  approveTaskMember,
  revokeTaskMember,
  archiveTask,
  hardDeleteTask,
  restoreTask,
  type Task,
  type TaskItem,
  type ProjectMember,
  type TaskMember,
  type ProjectWithRole,
  type TaskItemLastEditor,
} from "@/features/projects/projects";
import { subscribeMany, type RealtimeStatus } from "@/lib/supabase/realtime";
import { userMessage } from "@/lib/errors/user-message";
import { layout, spacing } from "@/components/ui/theme";
import { useTheme } from "@/components/ui/theme-provider";
import { useUser } from "@/features/auth/AuthProvider";
import { usePermissionVersion } from "@/features/auth/PermissionProvider";
import { ResourceAccessDeniedError } from "@/lib/errors/domain-errors";
import { filterChecklistItems } from "@/features/projects/checklist";
import { formatLastEditorLabel } from "@/features/projects/history-format";

export default function TaskScreen() {
  const { colors: theme } = useTheme();
  const { id, taskId } = useLocalSearchParams<{ id: string; taskId: string }>();
  const user = useUser();
  const permissionVersion = usePermissionVersion();
  const [task, setTask] = useState<Task | null>(null);
  const [project, setProject] = useState<ProjectWithRole | null>(null);
  const [items, setItems] = useState<TaskItem[]>([]);
  const [lastEditors, setLastEditors] = useState<Map<string, TaskItemLastEditor>>(new Map());
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [taskMembers, setTaskMembers] = useState<TaskMember[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [manageOpen, setManageOpen] = useState(false);
  const [hardDeleteConfirm, setHardDeleteConfirm] = useState(false);
  const [showArchivedItems, setShowArchivedItems] = useState(false);
  const [itemToDelete, setItemToDelete] = useState<TaskItem | null>(null);
  const [title, setTitle] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [taskEditing, setTaskEditing] = useState(false);
  const [editTaskTitle, setEditTaskTitle] = useState("");
  const [editTaskDescription, setEditTaskDescription] = useState("");
  const [commentEditing, setCommentEditing] = useState<string | null>(null);
  const [editComment, setEditComment] = useState("");
  const [editPercentage, setEditPercentage] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    action: () => Promise<unknown>;
  } | null>(null);
  const requestRef = useRef(0);
  const busyRef = useRef(false);
  const realtimeConnectedRef = useRef(false);

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
        nextLastEditors,
      ] = await Promise.all([
        getTask(taskId, id),
        getProject(id),
        listTaskItems(taskId, showArchivedItems ? "archived" : "active"),
        listProjectMembers(id),
        listTaskMembers(taskId),
        listTaskAssignees(taskId),
        listTaskItemLastEditors(taskId),
      ]);
      if (request !== requestRef.current) return;
      setTask(nextTask);
      setProject(nextProject);
      setItems(nextItems);
      setProjectMembers(nextProjectMembers);
      setTaskMembers(nextTaskMembers);
      setAssignees(nextAssignees);
      setLastEditors(new Map(nextLastEditors.map((entry) => [entry.task_item_id, entry])));
      setError("");
    } catch (e) {
      if (request === requestRef.current) {
        setTask(null);
        setProject(null);
        setItems([]);
        setProjectMembers([]);
        setTaskMembers([]);
        setAssignees([]);
        setLastEditors(new Map());
        setError(userMessage(e, "Нет доступа к задаче."));
        if (e instanceof ResourceAccessDeniedError) {
          router.replace("/projects" as never);
        }
      }
    }
  }, [id, taskId, showArchivedItems]);

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
      if (!taskId || !id) return;
      void permissionVersion;
      const onEvent = () => {
        void load();
      };
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
        {
          table: "tasks",
          options: { taskId, onEvent, onStatus },
        },
        {
          table: "task_items",
          options: { taskId, onEvent, onStatus },
        },
        {
          table: "task_members",
          options: { taskId, onEvent, onStatus },
        },
        {
          table: "task_assignees",
          options: { taskId, onEvent, onStatus },
        },
        ...(user
          ? [{
              table: "notifications",
              options: { userId: user.id, onEvent, onStatus },
            }]
          : []),
      ]);
    }, [id, taskId, user, load, permissionVersion]),
  );

  async function run(fn: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(userMessage(e, "Операция не выполнена."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function confirmAction() {
    if (!confirm) return;
    const action = confirm.action;
    setConfirm(null);
    await run(action);
  }
  async function hardDelete() { await run(async () => { await hardDeleteTask(taskId); setHardDeleteConfirm(false); router.back(); }); }

  function validateTaskEdit(): string | null {
    const nextTitle = editTaskTitle.trim();
    if (!nextTitle) return "Введите название задачи.";
    if (nextTitle.length > 500) return "Название задачи не должно быть длиннее 500 символов.";
    if (editTaskDescription.length > 10000) return "Описание задачи не должно быть длиннее 10000 символов.";
    return null;
  }

  function savePercentage(item: TaskItem) {
    const raw = editPercentage[item.id] ?? String(item.percentage);
    const value = Number(raw);
    if (!/^\d{1,3}$/.test(raw) || !Number.isInteger(value) || value < 0 || value > 100) {
      setError("Процент должен быть целым числом от 0 до 100.");
      return;
    }
    void run(() => setTaskItemPercentage(item.id, value));
  }

  const canManage =
    (project?.role === "owner" || project?.role === "admin") &&
    project?.status === "active" &&
    task?.status !== "archived";
  const canEdit =
    project?.status === "active" &&
    project.role !== "viewer" &&
    task?.status !== "archived";
  const canRestore =
    (project?.role === "owner" || project?.role === "admin") &&
    project?.status === "active" &&
    task?.status === "archived";
  const activeItems = items.filter((item) => !item.is_archived);
  const visibleItems = filterChecklistItems(items, showArchivedItems);
  const progress = activeItems.length ? activeItems.reduce((sum, item) => sum + item.percentage, 0) / activeItems.length : 0;

  return (
    <Screen padded={false} centerContent={false}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {task ? (
          <PageHeader
            title={taskEditing ? "Редактирование задачи" : task.title}
            subtitle={taskEditing ? "" : task.description || "Рабочая задача"}
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
            {taskEditing ? <Card>
              <Input label="Название" value={editTaskTitle} onChangeText={setEditTaskTitle} maxLength={500} placeholder="Название задачи" />
              <Textarea label="Описание" value={editTaskDescription} onChangeText={setEditTaskDescription} maxLength={10000} placeholder="Описание задачи" />
              <View style={styles.actions}>
                <Button disabled={busy || !editTaskTitle.trim()} onPress={() => { const validation = validateTaskEdit(); if (validation) { setError(validation); return; } void run(async () => { await updateTask(task.id, editTaskTitle.trim(), editTaskDescription); setTaskEditing(false); }); }}>Сохранить</Button>
                <Button variant="ghost" disabled={busy} onPress={() => setTaskEditing(false)}>Отмена</Button>
              </View>
            </Card> : null}
            {canEdit && !taskEditing ? <View style={styles.actions}><Button variant="outline" onPress={() => { setTaskEditing(true); setEditTaskTitle(task.title); setEditTaskDescription(task.description || ""); }}>Редактировать задачу</Button></View> : null}
            {canManage ? <View style={styles.actions}><Button variant="destructive" onPress={() => setConfirm({ title: "Архивировать задачу?", description: "Задача исчезнет из активного списка проекта.", action: () => archiveTask(taskId) })}>Архивировать задачу</Button></View> : null}
            {canRestore ? <View style={styles.actions}><Button disabled={busy} loading={busy} onPress={() => void run(() => restoreTask(taskId))}>Восстановить задачу</Button><Button variant="destructive" disabled={busy} onPress={() => setHardDeleteConfirm(true)}>Удалить навсегда</Button></View> : null}
            <Card>
              <Progress
                value={progress}
                label={`Прогресс · среднее по ${activeItems.length} активным пунктам`}
              />
            </Card>
            <View style={styles.sectionHead}>
              <ThemedText type="h2">Чек-лист</ThemedText>
              <View style={styles.actions}>{canManage ? <Button size="sm" variant="outline" onPress={() => setShowArchivedItems((value) => !value)}>{showArchivedItems ? 'Скрыть архив' : 'Показать архив'}</Button> : null}<Button size="sm" variant="outline" onPress={() => setManageOpen(true)} disabled={!canManage}>Участники и исполнители</Button><Button
                size="sm"
                variant="outline"
                onPress={() =>
                  router.push(
                    `/projects/${id}/tasks/${taskId}/history` as never,
                  )
                }
              >
                История
              </Button></View>
            </View>
            {!visibleItems.length ? (
              <EmptyState
                title={showArchivedItems ? "Архив чек-листа пуст" : "Чек-лист пуст"}
                description={showArchivedItems ? "Здесь появятся пункты после архивации." : "Добавьте первый пункт, чтобы разбить задачу на последовательные шаги."}
              />
            ) : (
              <View style={styles.list}>
                {visibleItems.map((item, index) => (
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
                              item.is_completed ? [styles.completed, { color: theme.textMuted }] : undefined
                            }
                          >
                            {index + 1}. {item.title}
                          </ThemedText>
                        )}
                        <Progress value={item.percentage} label={`Выполнено · ${item.percentage}%`} />
                        {item.comment ? <ThemedText type="small" style={{ color: theme.textSecondary }}>Комментарий: {item.comment}</ThemedText> : null}
                        <ThemedText type="caption" style={{ color: theme.textMuted }}>Последнее изменение: {formatLastEditorLabel(lastEditors.get(item.id))}</ThemedText>
                      </View>
                    </View>
                    {commentEditing === item.id ? <View style={styles.commentEditor}>
                      <Textarea label="Комментарий к пункту" value={editComment} onChangeText={setEditComment} maxLength={2000} placeholder="Необязательно" />
                      <View style={styles.actions}><Button size="sm" disabled={busy || editComment.length > 2000} onPress={() => void run(async () => { await setTaskItemComment(item.id, editComment); setCommentEditing(null); })}>Сохранить</Button><Button size="sm" variant="outline" disabled={busy} onPress={() => setCommentEditing(null)}>Отмена</Button></View>
                    </View> : null}
                    {canEdit && !item.is_archived ? <View style={styles.progressEditor}>
                      <Input label="Процент" value={editPercentage[item.id] ?? String(item.percentage)} onChangeText={(value) => setEditPercentage((current) => ({ ...current, [item.id]: value.replace(/[^0-9]/g, '').slice(0, 3) }))} keyboardType="numeric" maxLength={3} />
                      <Button size="sm" disabled={busy} onPress={() => savePercentage(item)}>Обновить %</Button>
                    </View> : null}
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
                    ) : item.is_archived && canManage ? (
                      <View style={styles.actions}><Badge tone="neutral">В архиве</Badge><Button size="sm" variant="destructive" disabled={busy} onPress={() => setItemToDelete(item)}>Удалить навсегда</Button></View>
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
                        <Button size="sm" variant="ghost" disabled={busy} onPress={() => { setCommentEditing(item.id); setEditComment(item.comment || ""); }}>
                          {item.comment ? "Изменить комментарий" : "Добавить комментарий"}
                        </Button>
                        {canManage ? <Button
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
                        </Button> : null}
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
              <Modal visible={manageOpen} animationType="slide" transparent onRequestClose={() => setManageOpen(false)}>
                <View style={[styles.modalBackdrop, { backgroundColor: theme.overlay }]}><View style={[styles.modalSheet, { backgroundColor: theme.surface }]} pointerEvents={confirm ? "none" : "auto"} accessibilityElementsHidden={Boolean(confirm)} importantForAccessibility={confirm ? "no-hide-descendants" : "auto"}><View style={styles.sectionHead}><ThemedText type="h2">Участники и исполнители</ThemedText><Button size="sm" variant="ghost" onPress={() => setManageOpen(false)}>Закрыть</Button></View><Card>
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
                </Card><Card>
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
                 </Card></View><ConfirmDialog
                   visible={Boolean(confirm)}
                   nested
                   title={confirm?.title || ""}
                   description={confirm?.description || ""}
                   confirmLabel="Подтвердить"
                   busy={busy}
                   onCancel={() => setConfirm(null)}
                   onConfirm={() => void confirmAction()}
                 /></View>
              </Modal>
            ) : null}
          </>
        )}
      </ScrollView>
      <ConfirmDialog
        visible={Boolean(confirm) && !manageOpen}
        title={confirm?.title || ""}
        description={confirm?.description || ""}
        confirmLabel="Подтвердить"
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void confirmAction()}
      />
      <ConfirmDialog visible={hardDeleteConfirm} title="Удалить задачу навсегда?" description="Архивная задача и её чек-лист будут удалены без возможности восстановления." confirmLabel="Удалить навсегда" busy={busy} onCancel={() => setHardDeleteConfirm(false)} onConfirm={() => void hardDelete()} />
      <ConfirmDialog visible={Boolean(itemToDelete)} title="Удалить пункт навсегда?" description="Архивный пункт чек-листа будет удалён без возможности восстановления." confirmLabel="Удалить навсегда" busy={busy} onCancel={() => setItemToDelete(null)} onConfirm={() => void run(async () => { if (itemToDelete) await hardDeleteTaskItem(itemToDelete.id); setItemToDelete(null); })} />
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
  modalBackdrop: { flex: 1, justifyContent: "flex-end", padding: 0 },
  modalSheet: { maxHeight: "90%", padding: spacing.lg, gap: spacing.md, borderTopLeftRadius: 12, borderTopRightRadius: 12, zIndex: 1, elevation: 1 },
  completed: { textDecorationLine: "line-through" },
  commentEditor: { gap: spacing.sm, marginTop: spacing.sm },
  progressEditor: { gap: spacing.sm, marginTop: spacing.sm },
});
