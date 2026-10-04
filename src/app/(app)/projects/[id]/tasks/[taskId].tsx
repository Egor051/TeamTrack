import { useOnlineRecovery } from '@/lib/connectivity/use-online-recovery';
import { useCallback, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Screen } from "@/components/ui/screen";
import { PageHeader } from "@/components/ui/page-header";
import { ThemedText } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TaskStatus } from "@/components/ui/task-status";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { RealtimeIndicator } from "@/components/ui/realtime-indicator";
import { ErrorMessage } from "@/components/ui/error-message";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
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
  listTaskAssignees,
  getMyTaskRole,
  listTaskMemberOverrides,
  setTaskMemberOverride,
  clearTaskMemberOverride,
  listTaskItemLastEditors,
  addTaskAssignee,
  removeTaskAssignee,
  archiveTask,
  hardDeleteTask,
  restoreTask,
  type Task,
  type TaskItem,
  type ProjectMember,
  type ProjectWithRole,
  type ProjectRole,
  type TaskChecklistRole,
  type TaskMemberOverride,
  type TaskItemLastEditor,
} from "@/features/projects/projects";
import { subscribeMany, type RealtimeStatus } from "@/lib/supabase/realtime";
import { userMessage } from "@/lib/errors/user-message";
import { layout, spacing } from "@/components/ui/theme";
import { useTheme } from "@/components/ui/theme-provider";
import { useUser } from "@/features/auth/AuthProvider";
import { usePermissionVersion } from "@/features/auth/PermissionProvider";
import { activeCacheUserId, getCached, isCachedResult, isExplicitAccessError, isTransportFailure } from "@/lib/local-cache/cache";
import { filterChecklistItems, formatChecklistComment, parsePercentageInput } from "@/features/projects/checklist";
import { formatLastEditorSummary } from "@/features/projects/history-format";
import { applyPendingOperations, listPendingOperations, offlineWriteEnabled, type SupportedEdit } from "@/lib/local-cache/outbox";
import { performSupportedEdit } from "@/lib/local-cache/edit";
import { subscribeSyncChanges } from "@/lib/local-cache/sync";
import { ChecklistLocalRepository } from "@/lib/local-cache/repository";
import { buildSyncEnabled } from "@/lib/local-cache/runtime-config";

const projectRoleLabels: Record<ProjectMember["role"], string> = {
  owner: "Владелец",
  admin: "Администратор",
  member: "Участник",
  viewer: "Только просмотр",
};

export default function TaskScreen() {
  const { colors: theme } = useTheme();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const compact = width < 700;
  const { id, taskId } = useLocalSearchParams<{ id: string; taskId: string }>();
  const user = useUser();
  const permissionVersion = usePermissionVersion();
  const [task, setTask] = useState<Task | null>(null);
  const [project, setProject] = useState<ProjectWithRole | null>(null);
  const [items, setItems] = useState<TaskItem[]>([]);
  const [summaryItems, setSummaryItems] = useState<TaskItem[]>([]);
  const [loadedView, setLoadedView] = useState<"active" | "archived" | null>(null);
  const [lastEditors, setLastEditors] = useState<Map<string, TaskItemLastEditor>>(new Map());
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [effectiveTaskRole, setEffectiveTaskRole] = useState<ProjectRole | null>(null);
  const [taskMemberOverrides, setTaskMemberOverrides] = useState<TaskMemberOverride[]>([]);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [manageOpen, setManageOpen] = useState(false);
  const [hardDeleteConfirm, setHardDeleteConfirm] = useState(false);
  const [showArchivedItems, setShowArchivedItems] = useState(false);
  const [expandedItem, setExpandedItem] = useState<string | null>(null);
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
  const [loadError, setLoadError] = useState("");
  const [offline, setOffline] = useState(false);
  const [offlineForEdits, setOfflineForEdits] = useState(false);
  const [pendingItemIds, setPendingItemIds] = useState<Set<string>>(new Set());
  const [failedItemIds, setFailedItemIds] = useState<Set<string>>(new Set());
  const [loadedUserId, setLoadedUserId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ message: string; target: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    action: () => Promise<unknown>;
    confirmLabel?: string;
    destructive?: boolean;
    target?: string;
  } | null>(null);
  const requestRef = useRef(0);
  const busyRef = useRef(false);
  const realtimeConnectedRef = useRef(false);

  const load = useCallback(async () => {
    if (!id || !taskId || !user) return;
    const request = ++requestRef.current;
    setLoadError("");
    let supplementaryOffline = false;
    async function optional<T>(promise: Promise<T>, fallback: T): Promise<T> {
      try { return await promise; }
      catch (error) {
        if (!isTransportFailure(error)) throw error;
        supplementaryOffline = true;
        return fallback;
      }
    }
    try {
      const [
        nextTask,
        nextProject,
        nextItems,
        nextProjectMembers,
        nextAssignees,
        nextLastEditors,
        nextActiveItems,
        nextTaskRole,
      ] = await Promise.all([
        getTask(taskId, id),
        getProject(id),
        listTaskItems(taskId, showArchivedItems ? "archived" : "active"),
        optional(listProjectMembers(id), [] as ProjectMember[]),
        optional(listTaskAssignees(taskId), [] as string[]),
        optional(listTaskItemLastEditors(taskId), [] as TaskItemLastEditor[]),
        showArchivedItems ? optional(listTaskItems(taskId, "active"), [] as TaskItem[]) : Promise.resolve(null),
        optional(getMyTaskRole(taskId), "viewer" as ProjectRole),
      ]);
      const pending = user ? await listPendingOperations(user.id, taskId) : [];
      const nextOverrides = nextProject.role === "owner" || nextProject.role === "admin"
        ? await optional(listTaskMemberOverrides(taskId), [] as TaskMemberOverride[])
        : [];
      if (request !== requestRef.current) return;
      if (await activeCacheUserId() !== user.id) return;
      setTask(nextTask);
      setLoadedUserId(user.id);
      setProject(nextProject);
      setItems(nextItems);
      setSummaryItems(nextActiveItems ?? nextItems);
      setPendingItemIds(new Set(pending.map((operation) => operation.task_item_id)));
      setFailedItemIds(new Set(pending.filter((operation) => operation.status === 'failed').map((operation) => operation.task_item_id)));
      setLoadedView(showArchivedItems ? "archived" : "active");
      setProjectMembers(nextProjectMembers);
      setEffectiveTaskRole(nextTaskRole);
      setTaskMemberOverrides(nextOverrides);
      setAssignees(nextAssignees);
      setLastEditors(new Map(nextLastEditors.map((entry) => [entry.task_item_id, entry])));
      setOffline(supplementaryOffline || [nextTask, nextProject, nextItems, nextProjectMembers, nextAssignees, nextLastEditors, nextActiveItems, nextOverrides].some(isCachedResult));
      setOfflineForEdits([nextTask, nextProject, nextItems, nextTaskRole].some(isCachedResult));
      setLoadError("");
    } catch (e) {
      if (request === requestRef.current) {
        setLoadError(userMessage(e, "Не удалось обновить этап."));
        if (isExplicitAccessError(e)) {
          setTask(null);
          setLoadedUserId(null);
          setProject(null);
          setItems([]);
          setSummaryItems([]);
          setPendingItemIds(new Set());
          setProjectMembers([]);
          setEffectiveTaskRole(null);
          setTaskMemberOverrides([]);
          setAssignees([]);
          setLastEditors(new Map());
          setOffline(false);
          setOfflineForEdits(false);
          router.replace("/projects" as never);
        }
      }
    }
  }, [id, taskId, showArchivedItems, user]);

  const primeLocal = useCallback(async () => {
    if (!buildSyncEnabled() || !user || !id || !taskId) return;
    const generation = requestRef.current;
    if (await getCached<boolean>(user.id, `blocked:${id}`)
      || await getCached<boolean>(user.id, `blocked-task:${taskId}`)) return;
    const [cachedTask, cachedProject, cachedRole, cachedItems, cachedActive] = await Promise.all([
      getCached<Task>(user.id, `task:${taskId}`),
      getCached<ProjectWithRole>(user.id, `project:${id}`),
      getCached<ProjectRole>(user.id, `task-role:${taskId}`),
      ChecklistLocalRepository.getEffectiveTaskItems(user.id, taskId, showArchivedItems ? 'archived' : 'active'),
      showArchivedItems ? ChecklistLocalRepository.getEffectiveTaskItems(user.id, taskId, 'active') : Promise.resolve(null),
    ]);
    if (!cachedTask || !cachedProject || !cachedItems || cachedTask.project_id !== id
      || cachedProject.id !== id || requestRef.current !== generation || await activeCacheUserId() !== user.id) return;
    const pending = await listPendingOperations(user.id, taskId);
    if (requestRef.current !== generation || await activeCacheUserId() !== user.id) return;
    setTask(cachedTask);
    setProject(cachedProject);
    setItems(cachedItems);
    setSummaryItems(cachedActive ?? cachedItems);
    setEffectiveTaskRole(cachedRole ?? 'viewer');
    setPendingItemIds(new Set(pending.map((row) => row.task_item_id)));
    setFailedItemIds(new Set(pending.filter((row) => row.status === 'failed').map((row) => row.task_item_id)));
    setLoadedView(showArchivedItems ? 'archived' : 'active');
    setLoadedUserId(user.id);
    setOffline(true);
    setOfflineForEdits(true);
  }, [id, taskId, user, showArchivedItems]);

  useOnlineRecovery(load);
  useFocusEffect(
    useCallback(() => {
      void permissionVersion;
      void (async () => { try { await primeLocal(); } catch { /* fall through to the server read */ } await load(); })();
      const unsubscribe = subscribeSyncChanges((changedUserId) => {
        if (changedUserId === user?.id) void load();
      });
      return () => {
        unsubscribe();
        requestRef.current += 1;
      };
    }, [load, primeLocal, permissionVersion, user?.id]),
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
          table: "projects",
          options: { projectId: id, onEvent, onStatus },
        },
        {
          table: "tasks",
          options: { taskId, onEvent, onStatus },
        },
        {
          table: "task_items",
          options: { taskId, onEvent, onStatus },
        },
        {
          table: "task_assignees",
          options: { taskId, onEvent, onStatus },
        },
        {
          table: "task_members",
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

  async function run(fn: () => Promise<unknown>, target = "task"): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setBusyAction(target);
    setActionError(null);
    let completed = false;
    try {
      if (offlineForEdits && offlineWriteEnabled()) throw new Error("Для этого действия требуется подключение к интернету.");
      await fn();
      completed = true;
      try {
        await load();
      } catch (e) {
        setLoadError(userMessage(e, "Не удалось обновить этап."));
      }
    } catch (e) {
      setActionError({ message: offlineWriteEnabled() && isTransportFailure(e)
        ? "Для этого действия требуется подключение к интернету."
        : userMessage(e, "Операция не выполнена."), target });
    } finally {
      busyRef.current = false;
      setBusy(false);
      setBusyAction(null);
    }
    return completed;
  }

  async function confirmAction() {
    if (!confirm) return;
    const { action, target } = confirm;
    const completed = await run(action, target);
    if (completed) setConfirm(null);
  }
  async function hardDelete() { await run(async () => { await hardDeleteTask(taskId); setHardDeleteConfirm(false); router.replace(`/projects/${id}` as never); }); }

  function validateTaskEdit(): string | null {
    const nextTitle = editTaskTitle.trim();
    if (!nextTitle) return "Введите название этапа.";
    if (nextTitle.length > 500) return "Название этапа не должно быть длиннее 500 символов.";
    if (editTaskDescription.length > 10000) return "Описание этапа не должно быть длиннее 10000 символов.";
    return null;
  }

  function savePercentage(item: TaskItem) {
    const raw = editPercentage[item.id] ?? String(item.percentage);
    const value = parsePercentageInput(raw);
    if (value === null) {
      setActionError({ message: "Введите целое число от 1 до 100.", target: item.id });
      return;
    }
    void runItemEdit(item, { type: 'set_task_item_percentage', payload: { percentage: value } }, () => setTaskItemPercentage(item.id, value), () => {
      setEditPercentage((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
    });
  }

  async function runItemEdit(item: TaskItem, edit: SupportedEdit, onlineAction: () => Promise<unknown>, afterSave?: () => void): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setBusyAction(item.id);
    setActionError(null);
    try {
      if (!user || !project || !task || !canUpdateChecklistProgress || item.is_archived || item.task_id !== taskId || project.status !== 'active' || task.status === 'archived') {
        throw new Error('Нет доступа к изменению пункта.');
      }
      const result = await performSupportedEdit({ userId: user.id, projectId: id, taskId, itemId: item.id,
        itemVersion: item.sync_version, offline: offlineForEdits, edit, onlineAction });
      if (result.kind === 'server') {
        afterSave?.();
        await load();
      } else {
        const { operation } = result;
        setItems((current) => applyPendingOperations(current, [operation], user.id, taskId));
        setSummaryItems((current) => applyPendingOperations(current, [operation], user.id, taskId));
        setPendingItemIds((current) => new Set(current).add(item.id));
        afterSave?.();
      }
    } catch (error) {
      setActionError({ message: userMessage(error, 'Операция не выполнена.'), target: item.id });
    } finally {
      busyRef.current = false;
      setBusy(false);
      setBusyAction(null);
    }
  }

  const canManageTask =
    (project?.role === "owner" || project?.role === "admin") &&
    project?.status === "active" &&
    task?.status !== "archived";
  const hasTaskAccess = Boolean(user && project && task && project.id === id && task.project_id === id);
  const canUpdateChecklistProgress =
    hasTaskAccess &&
    project?.status === "active" &&
    effectiveTaskRole !== null &&
    effectiveTaskRole !== "viewer" &&
    task?.status !== "archived";
  const canEditChecklist =
    hasTaskAccess &&
    project?.status === "active" &&
    (effectiveTaskRole === "owner" || effectiveTaskRole === "admin") &&
    task?.status !== "archived";
  const canEditTask = canManageTask;
  const canRestore =
    (project?.role === "owner" || project?.role === "admin") &&
    project?.status === "active" &&
    task?.status === "archived";
  const activeItems = summaryItems.filter((item) => !item.is_archived);
  const visibleItems = filterChecklistItems(items, showArchivedItems);
  const progress = activeItems.length ? activeItems.reduce((sum, item) => sum + item.percentage, 0) / activeItems.length : 0;
  const completedItems = activeItems.filter((item) => item.is_completed).length;
  const currentView = showArchivedItems ? "archived" : "active";
  const assigneeNames = assignees.map((assigneeId) => {
    const member = projectMembers.find((entry) => entry.user_id === assigneeId);
    return member?.profile?.display_name || assigneeId.slice(0, 8);
  });
  const overrideByUserId = new Map(taskMemberOverrides.map((entry) => [entry.user_id, entry.role_override]));

  if (!user || loadedUserId !== user.id) {
    return <Screen padded={false} centerContent={false}>{loadError ? <ErrorState message={loadError} onRetry={load} /> : <LoadingState label="Загружаем этап..." />}</Screen>;
  }

  return (
    <Screen padded={false} centerContent={false}>
      <ScrollView
        contentContainerStyle={[styles.content, compact && styles.compactContent]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <PageHeader
            title={task ? (taskEditing ? "Редактирование этапа" : task.title) : "Этап"}
            subtitle={taskEditing ? "" : task?.description || "Рабочий этап"}
            onBack={() => router.dismissTo(`/projects/${id}` as never)}
            backLabel="К проекту"
            breadcrumbs={[{ label: "Проекты", href: "/projects" }, { label: project?.name || "Проект", href: `/projects/${id}` }, { label: task?.title || "Этап" }]}
            actions={
              task ? <>
                <RealtimeIndicator status={status} />
                <TaskStatus status={task.status} />
              </> : null
            }
          />
        {loadError && !task ? (
          <ErrorState message={loadError} onRetry={load} />
        ) : !task ? (
          <LoadingState label="Загружаем этап..." />
        ) : (
          <>
            {offline ? <Card><ThemedText type="small">Нет подключения к сети. Показаны сохранённые данные.</ThemedText></Card> : null}
            {loadError ? <Card><ErrorMessage message={loadError} type="generic" /><Button size="sm" variant="outline" onPress={() => void load()}>Обновить данные</Button></Card> : null}
            {actionError?.target === "task" ? <ErrorMessage message={actionError.message} type="validation" /> : null}
            {taskEditing ? <Card>
              <Input label="Название" value={editTaskTitle} onChangeText={setEditTaskTitle} maxLength={500} placeholder="Название этапа" disabled={busy} />
              <Textarea label="Описание" value={editTaskDescription} onChangeText={setEditTaskDescription} maxLength={10000} placeholder="Описание этапа" disabled={busy} />
              <View style={styles.actions}>
                <Button loading={busyAction === "task"} disabled={busy || !editTaskTitle.trim()} onPress={() => { const validation = validateTaskEdit(); if (validation) { setActionError({ message: validation, target: "task" }); return; } void run(async () => { await updateTask(task.id, editTaskTitle.trim(), editTaskDescription); setTaskEditing(false); }); }}>Сохранить</Button>
                <Button variant="ghost" disabled={busy} onPress={() => setTaskEditing(false)}>Отмена</Button>
              </View>
            </Card> : null}
            <View style={[styles.stageActions, compact && styles.stageActionsCompact]}>
              {((canEditTask && !taskEditing) || canManageTask) ? <View style={[styles.stageActionsGroup, compact && styles.stageActionsGroupCompact]}>
                {canEditTask && !taskEditing ? <Button size="sm" variant="outline" disabled={busy} onPress={() => { setTaskEditing(true); setEditTaskTitle(task.title); setEditTaskDescription(task.description || ""); setActionError(null); }}>Редактировать</Button> : null}
                {canManageTask ? <Button size="sm" variant="outline" disabled={busy} onPress={() => setManageOpen(true)}>Участники и исполнители</Button> : null}
              </View> : null}
              <View style={[styles.stageActionsGroup, styles.stageActionsRight, compact && styles.stageActionsGroupCompact]}>
                <Button size="sm" variant="ghost" disabled={busy} onPress={() => router.replace(`/projects/${id}/tasks/${taskId}/history` as never)}>История</Button>
                <View accessibilityElementsHidden style={[styles.actionDivider, { backgroundColor: theme.border }]} />
                <Button size="sm" variant="ghost" disabled={busy} onPress={() => router.replace(`/projects/${id}/tasks/${taskId}/progress` as never)}>Прогресс дня</Button>
              </View>
            </View>
            {canRestore ? <View style={styles.actions}><Button disabled={busy} loading={busyAction === "restore"} onPress={() => void run(() => restoreTask(taskId), "restore")}>Восстановить этап</Button><Button variant="destructive" disabled={busy} onPress={() => setHardDeleteConfirm(true)}>Удалить навсегда</Button></View> : null}
            {!canUpdateChecklistProgress ? <View style={[styles.notice, { backgroundColor: theme.surfaceMuted }]}><ThemedText type="small">{project?.status === "archived" ? "Проект в архиве. Этап доступен для просмотра." : task.status === "archived" ? "Этап в архиве. Для продолжения работы восстановите его." : effectiveTaskRole === "viewer" ? "Для чек-листа этого этапа у вас доступ только для просмотра." : hasTaskAccess ? "Прогресс чек-листа сейчас недоступен." : "Нет доступа к этапу."}</ThemedText></View> : null}
            <Card muted>
              <Progress
                value={progress}
                label={activeItems.length ? `${completedItems} из ${activeItems.length} пунктов выполнено` : "Добавьте пункты, чтобы отслеживать выполнение"}
              />
              <ThemedText type="small">{assigneeNames.length ? `Исполнители: ${assigneeNames.join(", ")}` : "Исполнители пока не назначены"}</ThemedText>
            </Card>
            <View style={styles.sectionHead}>
              <View style={styles.sectionTitle}><ThemedText type="h2">Чек-лист</ThemedText><ThemedText type="small">{showArchivedItems ? "Архивные пункты доступны для просмотра." : "Отмечайте готовые пункты или уточняйте прогресс в деталях."}</ThemedText></View>
              {canEditChecklist ? <SegmentedControl value={currentView} accessibilityLabel="Пункты чек-листа" options={[{ value: "active", label: "Активные" }, { value: "archived", label: "Архив" }]} onChange={(value) => { if (busy) return; setShowArchivedItems(value === "archived"); setExpandedItem(null); setEditing(null); setCommentEditing(null); setActionError(null); }} /> : null}
            </View>
            {loadedView !== currentView ? (loadError ? <View style={styles.feedback}><ThemedText type="small">Выбранный список пунктов не загрузился.</ThemedText><Button size="sm" variant="outline" onPress={() => void load()}>Повторить</Button></View> : <LoadingState label={showArchivedItems ? "Загружаем архив…" : "Загружаем чек-лист…"} />) : !visibleItems.length ? (
              <EmptyState
                title={showArchivedItems ? "Архив чек-листа пуст" : "Чек-лист пуст"}
                description={showArchivedItems ? "Здесь появятся пункты после архивации." : canEditChecklist ? "Добавьте первый пункт, чтобы разбить этап на последовательные шаги." : "Участники проекта ещё не добавили пункты в этот этап."}
              />
            ) : (
              <View style={styles.list}>
                {visibleItems.map((item, index) => {
                  const percentageRaw = editPercentage[item.id] ?? String(item.percentage);
                  const parsedPercentage = parsePercentageInput(percentageRaw);
                  const percentageSaveValid = parsedPercentage !== null && parsedPercentage !== item.percentage;
                  const formattedComment = formatChecklistComment(item.comment);
                  return (
                  <Card key={item.id} muted={item.is_archived}>
                    <View style={styles.itemRow}>
                      <Checkbox
                        checked={item.is_completed}
                        disabled={busy || !canUpdateChecklistProgress || item.is_archived}
                        label={`${item.title}, ${item.is_completed ? "выполнено" : "не выполнено"}`}
                        onPress={() =>
                           void runItemEdit(item, { type: 'set_task_item_state', payload: { completed: !item.is_completed } }, () => setTaskItemState(item.id, !item.is_completed))
                        }
                      />
                      <View style={styles.flex}>
                        {editing === item.id && canEditChecklist ? (
                          <Input
                            label="Текст пункта"
                            placeholder="Текст пункта"
                            value={editTitle}
                            onChangeText={setEditTitle}
                            maxLength={500}
                            autoFocus
                            disabled={busy}
                          />
                        ) : (
                          <Pressable
                            accessible={false}
                            accessibilityElementsHidden
                            importantForAccessibility="no"
                            accessibilityRole="button"
                            accessibilityLabel={`${item.is_completed ? "Снять отметку" : "Отметить выполненным"}: ${item.title}`}
                            accessibilityState={{ disabled: busy || !canUpdateChecklistProgress || item.is_archived }}
                            disabled={busy || !canUpdateChecklistProgress || item.is_archived}
                             onPress={() => void runItemEdit(item, { type: 'set_task_item_state', payload: { completed: !item.is_completed } }, () => setTaskItemState(item.id, !item.is_completed))}
                            style={({ pressed }) => [styles.titleToggle, pressed && styles.pressed]}
                          >
                            <ThemedText style={item.is_completed ? [styles.completed, { color: theme.textMuted }] : undefined}>
                              {index + 1}. {item.title}
                            </ThemedText>
                          </Pressable>
                        )}
                        {formattedComment ? <ThemedText type="small" style={styles.itemComment}>{formattedComment}</ThemedText> : null}
                        <View style={styles.itemMeta}>
                           <Badge tone={item.is_archived ? "neutral" : item.is_completed ? "success" : item.percentage > 0 ? "primary" : "neutral"}>{item.is_archived ? "В архиве" : item.is_completed ? "Готово" : item.percentage > 0 ? `${item.percentage}% выполнено` : "Не начат"}</Badge>
                           {pendingItemIds.has(item.id) ? <ThemedText type="caption" accessibilityLiveRegion="polite" style={failedItemIds.has(item.id) ? { color: theme.warning } : undefined}>{failedItemIds.has(item.id) ? 'Не удалось синхронизировать' : 'Ожидает синхронизации'}</ThemedText> : null}
                          {busyAction === item.id ? <ThemedText type="caption" accessibilityLiveRegion="polite">Сохраняем…</ThemedText> : null}
                        </View>
                         {!pendingItemIds.has(item.id) && formatLastEditorSummary(lastEditors.get(item.id)) ? <ThemedText type="caption">Последнее изменение: {formatLastEditorSummary(lastEditors.get(item.id))}</ThemedText> : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          style={styles.itemDetailsButton}
                          accessibilityLabel={`${expandedItem === item.id ? "Свернуть" : "Открыть"} детали пункта ${item.title}`}
                          accessibilityState={{ expanded: expandedItem === item.id }}
                          disabled={busy}
                          onPress={() => { setExpandedItem(expandedItem === item.id ? null : item.id); setEditing(null); setCommentEditing(null); }}
                        >
                          {expandedItem === item.id ? "Свернуть" : "Детали"}
                        </Button>
                      </View>
                    </View>
                    {expandedItem === item.id ? <View style={[styles.itemDetails, { borderTopColor: theme.border }]}>
                    <Progress value={item.percentage} label="Выполнение пункта" />
                    {commentEditing === item.id ? <View style={styles.commentEditor}>
                      <Textarea label="Комментарий к пункту" value={editComment} onChangeText={setEditComment} maxLength={10000} placeholder="Необязательно" disabled={busy} />
                       <View style={styles.actions}><Button size="sm" loading={busyAction === item.id} disabled={busy || editComment.length > 10000} onPress={() => void runItemEdit(item, { type: 'set_task_item_comment', payload: { comment: editComment } }, () => setTaskItemComment(item.id, editComment), () => setCommentEditing(null))}>Сохранить комментарий</Button><Button size="sm" variant="outline" disabled={busy} onPress={() => setCommentEditing(null)}>Отмена</Button></View>
                    </View> : null}
                    {canUpdateChecklistProgress && !item.is_archived && editing !== item.id && commentEditing !== item.id ? <View style={styles.progressEditor}>
                      <View style={styles.percentageField}><Input label="Прогресс, от 1 до 100%" value={percentageRaw} onChangeText={(value) => setEditPercentage((current) => ({ ...current, [item.id]: value }))} keyboardType="numeric" maxLength={7} onSubmitEditing={() => savePercentage(item)} disabled={busy} /></View>
                      <Button size="sm" variant={percentageSaveValid ? "primary" : "secondary"} loading={busyAction === item.id} disabled={busy || !percentageSaveValid} onPress={() => savePercentage(item)}>Сохранить прогресс</Button>
                    </View> : null}
                    {editing === item.id && canEditChecklist ? (
                      <View style={styles.actions}>
                        <Button
                          size="sm"
                          loading={busyAction === item.id}
                          disabled={busy || !editTitle.trim()}
                          onPress={() =>
                            void run(async () => {
                              await updateTaskItem(item.id, editTitle.trim());
                              setEditing(null);
                            }, item.id)
                          }
                        >
                          Сохранить
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onPress={() => setEditing(null)}
                        >
                          Отмена
                        </Button>
                      </View>
                    ) : item.is_archived && canEditChecklist ? (
                      <View style={styles.actions}><Button size="sm" variant="destructive" disabled={busy} onPress={() => setItemToDelete(item)}>Удалить навсегда</Button></View>
                    ) : canUpdateChecklistProgress && !item.is_archived && commentEditing !== item.id ? (
                      <View style={styles.actions}>
                        {canEditChecklist ? <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onPress={() => {
                            setEditing(item.id);
                            setEditTitle(item.title);
                          }}
                        >
                          Изменить текст
                        </Button> : null}
                        <Button size="sm" variant="ghost" disabled={busy} onPress={() => { setCommentEditing(item.id); setEditComment(item.comment || ""); }}>
                          {item.comment ? "Изменить комментарий" : "Добавить комментарий"}
                        </Button>
                        {canEditChecklist ? <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onPress={() =>
                            setConfirm({
                              title: "Архивировать пункт?",
                              description:
                                "Пункт переместится в архив и больше не будет учитываться в прогрессе этапа.",
                              action: () => archiveTaskItem(item.id),
                              confirmLabel: "Архивировать",
                              destructive: false,
                              target: item.id,
                            })
                          }
                        >
                          Архивировать
                        </Button> : null}
                      </View>
                    ) : null}
                    </View> : null}
                    {actionError?.target === item.id ? <ErrorMessage message={actionError.message} type="validation" /> : null}
                  </Card>
                  );
                })}
              </View>
            )}
            {canEditChecklist && !showArchivedItems ? (
              <Card>
                <Input
                  label="Новый пункт"
                  placeholder="Что нужно сделать?"
                  value={title}
                  onChangeText={setTitle}
                  maxLength={500}
                  disabled={busy}
                />
                <Button
                  disabled={busy || !title.trim()}
                  loading={busyAction === "new-item"}
                  onPress={() =>
                    void run(async () => {
                      await createTaskItem(taskId, title.trim());
                      setTitle("");
                    }, "new-item")
                  }
                >
                  Добавить пункт
                </Button>
                {actionError?.target === "new-item" ? <ErrorMessage message={actionError.message} type="validation" /> : null}
              </Card>
            ) : null}
            {canManageTask ? <View style={[styles.taskFooter, { borderTopColor: theme.border }]}><ThemedText type="small" style={styles.footerCopy}>Этап больше не нужен в текущей работе?</ThemedText><Button size="sm" variant="outline" disabled={busy} onPress={() => setConfirm({ title: "Архивировать этап?", description: "Этап переместится в архив проекта. Его можно будет восстановить вместе с чек-листом.", action: () => archiveTask(taskId), confirmLabel: "Архивировать", destructive: false })}>Архивировать этап</Button></View> : null}
            {task && canManageTask ? (
              <Modal visible={manageOpen} animationType="slide" transparent onRequestClose={() => { if (!busy) setManageOpen(false); }}>
                <View style={[styles.modalBackdrop, !compact && styles.modalBackdropDesktop, { backgroundColor: theme.overlay }]}><View style={[styles.modalSheet, !compact && styles.modalSheetDesktop, { backgroundColor: theme.surface, paddingBottom: Math.max(insets.bottom, spacing.lg) }]} accessibilityViewIsModal pointerEvents={confirm ? "none" : "auto"} accessibilityElementsHidden={Boolean(confirm)} importantForAccessibility={confirm ? "no-hide-descendants" : "auto"}>
                  <View style={styles.sectionHead}><View style={styles.flex}><ThemedText type="h2">Участники и исполнители</ThemedText><ThemedText type="small" numberOfLines={2}>{task.title}</ThemedText></View><Button size="sm" variant="ghost" disabled={busy} onPress={() => setManageOpen(false)}>Закрыть</Button></View>
                  <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
                  {!canManageTask ? <ThemedText type="small">Управлять доступом и назначениями могут владелец и администратор активного проекта.</ThemedText> : null}
                  {actionError?.target === "members" ? <ErrorMessage message={actionError.message} type="validation" /> : null}
                  {busyAction === "members" ? <ThemedText type="small" accessibilityLiveRegion="polite">Сохраняем изменения…</ThemedText> : null}
                  <Card>
                  <ThemedText type="h2">Участники этапа</ThemedText>
                  <ThemedText type="small">
                    По умолчанию роль наследуется из проекта. Изменение ниже действует только на чек-лист этого этапа.
                  </ThemedText>
                  {!projectMembers.length ? (
                    <EmptyState
                      title="Участников нет"
                      description="В проекте пока нет доступных участников."
                    />
                  ) : (
                    projectMembers.map((member) => {
                      const override = overrideByUserId.get(member.user_id);
                      const canManageMemberOverride = project?.role === "owner" || (member.role !== "owner" && member.role !== "admin");
                      const overrideOptions = [
                        { value: "inherit", label: `Наследовать: ${projectRoleLabels[member.role]}` },
                        ...(["admin", "member", "viewer"] as TaskChecklistRole[])
                          .filter((role) => role !== member.role)
                          .map((role) => ({ value: role, label: `Чек-лист: ${projectRoleLabels[role]}` })),
                      ];
                      return (
                        <View key={member.user_id} style={styles.memberRow}>
                          <ThemedText style={styles.flex}>
                            {member.profile?.display_name || member.user_id.slice(0, 8)}
                          </ThemedText>
                          <View style={styles.overrideControl}>
                            <Select
                              value={override ?? "inherit"}
                              options={overrideOptions}
                              onChange={(value) => void run(
                                () => value === "inherit"
                                  ? clearTaskMemberOverride(taskId, member.user_id)
                                  : setTaskMemberOverride(taskId, member.user_id, value as TaskChecklistRole),
                                "members",
                              )}
                              accessibilityLabel={`Роль чек-листа для ${member.profile?.display_name || member.user_id.slice(0, 8)}`}
                              disabled={busy || !canManageMemberOverride}
                            />
                            <ThemedText type="caption">
                              Проект: {projectRoleLabels[member.role]}{override ? ` · На этапе: ${projectRoleLabels[override]}` : " · Без переопределения"}
                            </ThemedText>
                          </View>
                        </View>
                      );
                    })
                  )}
                </Card><Card>
                  <ThemedText type="h2">Исполнители</ThemedText>
                  <ThemedText type="small">
                    Кто назначен выполнять этап
                  </ThemedText>
                  {projectMembers.length ? (
                    projectMembers.map((member) => {
                      const assigned = assignees.includes(member.user_id);
                      return (
                        <View key={member.user_id} style={styles.memberRow}>
                          <ThemedText style={styles.flex}>
                            {member.profile?.display_name || member.user_id.slice(0, 8)}
                          </ThemedText>
                          {assigned ? (
                            <Badge tone="primary">Назначен</Badge>
                          ) : null}
                          {canManageTask ? <Button
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
                                confirmLabel: assigned ? "Снять назначение" : "Назначить",
                                destructive: false,
                                target: "members",
                                action: () =>
                                  assigned
                                    ? removeTaskAssignee(taskId, member.user_id)
                                    : addTaskAssignee(taskId, member.user_id),
                              })
                            }
                          >
                            {assigned ? "Снять" : "Назначить"}
                          </Button> : null}
                        </View>
                      );
                    })
                  ) : (
                    <ThemedText type="small">В проекте пока нет участников.</ThemedText>
                  )}
                 </Card></ScrollView></View><ConfirmDialog
                   visible={Boolean(confirm)}
                   nested
                   title={confirm?.title || ""}
                   description={confirm?.description || ""}
                   confirmLabel={confirm?.confirmLabel || "Подтвердить"}
                   destructive={confirm?.destructive ?? true}
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
        confirmLabel={confirm?.confirmLabel || "Подтвердить"}
        destructive={confirm?.destructive ?? true}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void confirmAction()}
      />
      <ConfirmDialog visible={hardDeleteConfirm} title="Удалить этап навсегда?" description="Архивный этап и его чек-лист будут удалены без возможности восстановления." confirmLabel="Удалить навсегда" busy={busy} onCancel={() => setHardDeleteConfirm(false)} onConfirm={() => void hardDelete()} />
      <ConfirmDialog visible={Boolean(itemToDelete)} title="Удалить пункт навсегда?" description="Архивный пункт чек-листа будет удалён без возможности восстановления." confirmLabel="Удалить навсегда" busy={busy} onCancel={() => setItemToDelete(null)} onConfirm={() => { const item = itemToDelete; if (item) void run(async () => { await hardDeleteTaskItem(item.id); setItemToDelete(null); }, item.id); }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    width: "100%",
    maxWidth: layout.readingMaxWidth + 120,
    alignSelf: "center",
    padding: spacing.xl,
    gap: spacing.xl,
  },
  compactContent: { padding: spacing.lg, gap: spacing.lg },
  feedback: { gap: spacing.sm },
  sectionTitle: { flex: 1, minWidth: 0, gap: spacing.xs },
  notice: { padding: spacing.md, borderRadius: 8 },
  sectionHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.md,
  },
  list: { gap: spacing.md },
  itemRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  itemMeta: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.xs },
  itemDetailsButton: { alignSelf: "flex-start", marginTop: spacing.xs },
  itemComment: { marginTop: spacing.xs },
  itemDetails: { gap: spacing.md, borderTopWidth: 1, paddingTop: spacing.lg },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexWrap: "wrap",
    paddingVertical: spacing.sm,
  },
  overrideControl: { width: 280, maxWidth: "100%", gap: spacing.xs },
  flex: { flex: 1, minWidth: 0 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  stageActions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: spacing.md },
  stageActionsCompact: { alignItems: "stretch" },
  stageActionsGroup: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm, maxWidth: "100%", minWidth: 0 },
  stageActionsGroupCompact: { width: "100%" },
  stageActionsRight: { marginLeft: "auto", justifyContent: "flex-end" },
  actionDivider: { width: 1, height: 44, marginHorizontal: spacing.xs },
  taskFooter: { borderTopWidth: 1, paddingTop: spacing.md, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
  footerCopy: { flex: 1, minWidth: 140 },
  modalBackdrop: { flex: 1, justifyContent: "flex-end", alignItems: "center" },
  modalBackdropDesktop: { justifyContent: "center", padding: spacing.xl },
  modalSheet: { width: "100%", maxWidth: 780, maxHeight: "90%", padding: spacing.lg, gap: spacing.md, borderTopLeftRadius: 16, borderTopRightRadius: 16, zIndex: 1, elevation: 1 },
  modalSheetDesktop: { borderRadius: 16, padding: spacing.xl },
  modalScroll: { flexShrink: 1 },
  modalContent: { gap: spacing.lg, paddingBottom: spacing.xs },
  completed: { textDecorationLine: "line-through" },
  commentEditor: { gap: spacing.sm, marginTop: spacing.sm },
  progressEditor: { flexDirection: "row", alignItems: "flex-end", flexWrap: "wrap", gap: spacing.sm },
  percentageField: { width: 210, maxWidth: "100%" },
  titleToggle: { flexShrink: 1, minWidth: 0, borderRadius: 6 },
  pressed: { opacity: 0.7 },
});
