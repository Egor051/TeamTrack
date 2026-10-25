import { isReadAccessPending } from '@/lib/local-cache/read-freshness';
import { useReadModelUpdates } from '@/lib/local-cache/use-read-model-updates';
import { useOnlineRecovery } from '@/lib/connectivity/use-online-recovery';
import { useCallback, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { ModalLayer } from '@/components/ui/modal-layer';
import { TaskMembersPanel } from '@/features/projects/task-members-panel';
import { taskReadStep } from '@/features/projects/task-read';
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
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  getTask,
  getTaskItemForEdit,
  getTaskProjectContext,
  listTaskItems,
  createTaskItem,
  updateTaskItem,
  archiveTaskItem,
  hardDeleteTaskItem,
  setTaskItemState,
  setTaskItemPercentage,
  setTaskItemComment,
  setTaskItemDeadline,
  updateTask,
  listTaskParticipants,
  listTaskAssignees,
  getMyTaskRole,
  listTaskItemLastEditors,
  archiveTask,
  hardDeleteTask,
  restoreTask,
  type Task,
  type TaskItem,
  type ProjectRole,
  type TaskProjectContext,
  type TaskParticipant,
  type TaskItemLastEditor,
} from "@/features/projects/projects";
import { subscribeMany, type RealtimeStatus } from "@/lib/supabase/realtime";
import { userMessage } from "@/lib/errors/user-message";
import { layout, spacing } from "@/components/ui/theme";
import { useTheme } from "@/components/ui/theme-provider";
import { useUser } from "@/features/auth/AuthProvider";
import { usePermissionVersion } from "@/features/auth/PermissionProvider";
import { activeCacheUserId, getCached, isCachedResult, isExplicitAccessError, isTransportFailure, SupersededReadError, isTaskProjectBlocked } from "@/lib/local-cache/cache";
import { filterChecklistItems, formatChecklistComment, parsePercentageInput } from "@/features/projects/checklist";
import { formatLastEditorSummary } from "@/features/projects/history-format";
import { applyPendingOperations, listPendingOperations, offlineWriteEnabled, type SupportedEdit } from "@/lib/local-cache/outbox";
import { performSupportedEdit } from "@/lib/local-cache/edit";
import { subscribeSyncChanges } from "@/lib/local-cache/sync";
import { ChecklistLocalRepository } from "@/lib/local-cache/repository";
import { buildSyncEnabled } from "@/lib/local-cache/runtime-config";
import { ChecklistDeadline, DeadlineBadge, DeadlineCard } from '@/components/ui/deadline-status';
import { DeadlinePicker } from '@/components/ui/deadline-picker';
import { useDeadlineClock } from '@/features/projects/use-deadline-clock';
import { deadlineState, deadlineSummary, progressStatus } from '@/features/projects/deadlines';
import { russianCount } from '@/lib/russian';

const projectRoleLabels: Record<ProjectRole, string> = {
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
  const { id, taskId, item: linkedItem } = useLocalSearchParams<{ id: string; taskId: string; item?: string }>();
  const user = useUser();
  const permissionVersion = usePermissionVersion();
  const [task, setTask] = useState<Task | null>(null);
  const [project, setProject] = useState<TaskProjectContext | null>(null);
  const [items, setItems] = useState<TaskItem[]>([]);
  const [summaryItems, setSummaryItems] = useState<TaskItem[]>([]);
  const [loadedView, setLoadedView] = useState<"active" | "archived" | null>(null);
  const [lastEditors, setLastEditors] = useState<Map<string, TaskItemLastEditor>>(new Map());
  const [participants, setParticipants] = useState<TaskParticipant[]>([]);
  const [effectiveTaskRole, setEffectiveTaskRole] = useState<ProjectRole | null>(null);
  const [assignees, setAssignees] = useState<string[]>([]);
  const [manageOpen, setManageOpen] = useState(false);
  const [hardDeleteConfirm, setHardDeleteConfirm] = useState(false);
  const [showArchivedItems, setShowArchivedItems] = useState(false);
  const [expansion, setExpansion] = useState({ query: linkedItem, id: linkedItem ?? null as string | null });
  const expandedItem = expansion.query === linkedItem ? expansion.id : linkedItem ?? null;
  const setExpandedItem = (itemId: string | null) => setExpansion({ query: linkedItem, id: itemId });
  const [deadlineEditing, setDeadlineEditing] = useState<TaskItem | null>(null);
  const [deadlineConflict, setDeadlineConflict] = useState<TaskItem | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const listTop = useRef(0);
  const linkedPositions = useRef(new Map<string, number>());
  const now = useDeadlineClock(summaryItems);
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
  const [draftVersions, setDraftVersions] = useState<Record<string, number>>({});
  const draftVersion = (item: TaskItem, field: string) => draftVersions[`${item.id}:${field}`] ?? item.sync_version;
  const [loadError, setLoadError] = useState("");
  const [supplementaryError, setSupplementaryError] = useState("");
  const [taskEditBase, setTaskEditBase] = useState<Pick<Task, 'id' | 'title' | 'description'> | null>(null);
  const snapshotRef = useRef<{ scope: string; participants: TaskParticipant[]; assignees: string[]; editors: TaskItemLastEditor[] } | null>(null);
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
  const loadedScopeRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const realtimeConnectedRef = useRef(false);

  const load = useCallback(async () => {
    if (!id || !taskId || !user) return;
    if (isReadAccessPending(`task:${taskId}`)) setEffectiveTaskRole(null);
    const request = ++requestRef.current;
    setLoadError("");
    const scope = [user.id, id, taskId, showArchivedItems].join(':');
    const previous = snapshotRef.current?.scope === scope ? snapshotRef.current : null;
    let supplementaryOffline = false;
    let supplementaryFailed = false;
    async function optional<T>(step: string, read: () => Promise<T>, fallback: T): Promise<T> {
      try { return await taskReadStep(step, read); }
      catch (error) {
        if (error instanceof SupersededReadError || isExplicitAccessError(error)) throw error;
        supplementaryOffline ||= isTransportFailure(error);
        supplementaryFailed = true;
        return fallback;
      }
    }
    try {
      const [nextTask, nextProject, nextItems, nextTaskRole, nextParticipants, nextAssignees, nextLastEditors, nextActiveItems] = await Promise.all([
        taskReadStep('stage', () => getTask(taskId, id)),
        taskReadStep('project-context', () => getTaskProjectContext(taskId)),
        taskReadStep('checklist', () => listTaskItems(taskId, showArchivedItems ? 'archived' : 'active')),
        taskReadStep('effective-role', () => getMyTaskRole(taskId)),
        optional('participants', () => listTaskParticipants(taskId), previous?.participants ?? []),
        optional('assignees', () => listTaskAssignees(taskId), previous?.assignees ?? []),
        optional('last-editors', () => listTaskItemLastEditors(taskId), previous?.editors ?? []),
        showArchivedItems ? taskReadStep('active-summary', () => listTaskItems(taskId, 'active')) : Promise.resolve(null),
      ]);
      if (nextProject.id !== id) throw new Error('Этап относится к другому проекту.');
      const pending = await listPendingOperations(user.id, taskId);
      if (request !== requestRef.current) return;
      if (await activeCacheUserId() !== user.id) return;
      loadedScopeRef.current = `${user.id}:${id}:${taskId}:${showArchivedItems}`;
      setTask(nextTask);
      setLoadedUserId(user.id);
      setProject(nextProject);
      setItems(nextItems);
      setSummaryItems(nextActiveItems ?? nextItems);
      setPendingItemIds(new Set(pending.map((operation) => operation.task_item_id)));
      setFailedItemIds(new Set(pending.filter((operation) => operation.status === 'failed').map((operation) => operation.task_item_id)));
      setLoadedView(showArchivedItems ? "archived" : "active");
      snapshotRef.current = { scope, participants: nextParticipants, assignees: nextAssignees, editors: nextLastEditors };
      setParticipants(nextParticipants);
      setSupplementaryError(supplementaryFailed ? "Часть дополнительных данных этапа не обновилась. Повторите обновление данных." : "");
      setEffectiveTaskRole(nextTaskRole);
      setAssignees(nextAssignees);
      setLastEditors(new Map(nextLastEditors.map((entry) => [entry.task_item_id, entry])));
      setOffline(supplementaryOffline || [nextTask, nextProject, nextItems, nextParticipants, nextAssignees, nextLastEditors, nextActiveItems].some(isCachedResult));
      setOfflineForEdits([nextTask, nextProject, nextItems, nextTaskRole].some(isCachedResult));
      setLoadError("");
    } catch (e) {
      if (e instanceof SupersededReadError) return;
      if (request === requestRef.current) {
        setLoadError(userMessage(e, "Не удалось обновить этап."));
        if (isExplicitAccessError(e)) {
          loadedScopeRef.current = null;
          setTask(null);
          setLoadedUserId(null);
          setProject(null);
          setItems([]);
          setSummaryItems([]);
          setPendingItemIds(new Set());
          snapshotRef.current = null;
          setParticipants([]);
          setEffectiveTaskRole(null);
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
    const scope = `${user.id}:${id}:${taskId}:${showArchivedItems}`;
    // ACL/focus refreshes revalidate the existing view. Replaying its startup
    // snapshot would briefly replace live data and claim the online view is offline.
    if (loadedScopeRef.current === scope) return;
    const generation = requestRef.current;
    if (await isTaskProjectBlocked(user.id, taskId, id)
      || await getCached<boolean>(user.id, `blocked-task:${taskId}`)) return;
    const [cachedTask, cachedProject, cachedRole, cachedItems, cachedActive] = await Promise.all([
      getCached<Task>(user.id, `task:${taskId}`),
      getCached<TaskProjectContext>(user.id, `task-context:${taskId}`),
      getCached<ProjectRole>(user.id, `task-role:${taskId}`),
      ChecklistLocalRepository.getEffectiveTaskItems(user.id, taskId, showArchivedItems ? 'archived' : 'active'),
      showArchivedItems ? ChecklistLocalRepository.getEffectiveTaskItems(user.id, taskId, 'active') : Promise.resolve(null),
    ]);
    if (!cachedTask || !cachedProject || !cachedItems || cachedTask.project_id !== id
      || cachedProject.id !== id || requestRef.current !== generation || await activeCacheUserId() !== user.id) return;
    const [pending, cachedParticipants, cachedAssignees] = await Promise.all([listPendingOperations(user.id, taskId), getCached<TaskParticipant[]>(user.id, `task-participants:${taskId}`).then((rows) => rows ?? []), getCached<string[]>(user.id, `assignees:${taskId}`).then((rows) => rows ?? [])]);
    if (requestRef.current !== generation || await activeCacheUserId() !== user.id) return;
    loadedScopeRef.current = scope;
    setTask(cachedTask);
    setProject(cachedProject);
    setParticipants(cachedParticipants);
    setAssignees(cachedAssignees);
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

  const { scheduleRefresh, refreshFromServer } = useReadModelUpdates(load, { projectId: id, taskId });
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
        {
          table: "projects",
          options: { taskId, onEvent, onStatus },
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
    }, [id, taskId, user, permissionVersion, scheduleRefresh]),
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
    const version = draftVersion(item, 'percentage');
    void runItemEdit(item, { type: 'set_task_item_percentage', payload: { percentage: value } }, () => setTaskItemPercentage(item.id, value, version), () => {
      setEditPercentage((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      setDraftVersions((current) => { const next = { ...current }; delete next[`${item.id}:percentage`]; return next; });
    }, version);
  }

  async function runItemEdit(item: TaskItem, edit: SupportedEdit, onlineAction: () => Promise<unknown>, afterSave?: () => void, version = item.sync_version): Promise<void> {
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
        itemVersion: version, offline: offlineForEdits, edit, onlineAction });
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
      if ((error as { code?: string })?.code === 'PT409') await load();
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
  const completedItems = activeItems.filter((item) => item.percentage === 100).length;
  const currentView = showArchivedItems ? "archived" : "active";
  const assigneeNames = assignees.map((assigneeId) => {
    return participants.find((entry) => entry.user_id === assigneeId)?.display_name || assigneeId.slice(0, 8);
  });

  const editingThisTask = taskEditing && taskEditBase?.id === taskId;
  const taskEditConflict = editingThisTask && taskEditBase && (taskEditBase.title !== task?.title || taskEditBase.description !== task?.description);
  if (!user || loadedUserId !== user.id || task?.id !== taskId || project?.id !== id) {
    return <Screen padded={false} centerContent={false}>{loadError ? <ErrorState message={loadError} onRetry={refreshFromServer} /> : <LoadingState label="Загружаем этап..." />}</Screen>;
  }

  return (
    <Screen padded={false} centerContent={false}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[styles.content, compact && styles.compactContent]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <PageHeader
            title={task ? (editingThisTask ? "Редактирование этапа" : task.title) : "Этап"}
            subtitle={editingThisTask ? "" : task?.description || "Рабочий этап"}
            onBack={() => router.dismissTo((project?.role ? `/projects/${id}` : "/projects") as never)}
            backLabel={project?.role ? "К проекту" : "К проектам"}
            breadcrumbs={[{ label: "Проекты", href: "/projects" }, { label: project?.name || "Проект", ...(project?.role ? { href: `/projects/${id}` } : {}) }, { label: task?.title || "Этап" }]}
            actions={
              task ? <>
                <RealtimeIndicator status={status} />
              </> : null
            }
          />
        {loadError && !task ? (
          <ErrorState message={loadError} onRetry={refreshFromServer} />
        ) : !task ? (
          <LoadingState label="Загружаем этап..." />
        ) : (
          <>
            {offline ? <Card><ThemedText type="small">Показаны сохранённые данные.</ThemedText></Card> : null}
            {loadError ? <Card><ErrorMessage message={loadError} type="generic" /><Button size="sm" variant="outline" onPress={() => void refreshFromServer()}>Обновить данные</Button></Card> : null}
            {actionError?.target === "task" ? <ErrorMessage message={actionError.message} type="validation" /> : null}
            {supplementaryError ? <Card><ErrorMessage message={supplementaryError} type="generic" /><Button size="sm" variant="outline" onPress={() => void refreshFromServer()}>Обновить дополнительные данные</Button></Card> : null}
            {editingThisTask ? <Card>
              {actionError?.target === 'task' ? <Button size="sm" variant="outline" disabled={busy} onPress={() => void refreshFromServer()}>Обновить данные этапа</Button> : null}
              {taskEditConflict ? <Card muted><ThemedText type="small">На сервере этап изменился. Ваш черновик сохранён в полях ниже.</ThemedText><ThemedText type="h3">{task.title}</ThemedText><ThemedText type="small">{task.description || 'Без описания'}</ThemedText><Button size="sm" variant="outline" disabled={busy} onPress={() => setTaskEditBase({ id: task.id, title: task.title, description: task.description })}>Продолжить с моим черновиком</Button></Card> : null}
              <Input label="Название" value={editTaskTitle} onChangeText={setEditTaskTitle} maxLength={500} placeholder="Название этапа" disabled={busy} />
              <Textarea label="Описание" value={editTaskDescription} onChangeText={setEditTaskDescription} maxLength={10000} placeholder="Описание этапа" disabled={busy} />
              <View style={styles.actions}>
                <Button loading={busyAction === "task"} disabled={busy || !editTaskTitle.trim() || !!taskEditConflict || !taskEditBase || taskEditBase.id !== taskId} onPress={() => { const validation = validateTaskEdit(); if (validation) { setActionError({ message: validation, target: "task" }); return; } void run(async () => { await updateTask(task.id, editTaskTitle.trim(), editTaskDescription, taskEditBase!); setTaskEditing(false); }); }}>Сохранить</Button>
                <Button variant="ghost" disabled={busy} onPress={() => setTaskEditing(false)}>Отмена</Button>
              </View>
            </Card> : null}
            <View style={[styles.stageActions, compact && styles.stageActionsCompact]}>
              {((canEditTask && !editingThisTask) || canManageTask) ? <View style={[styles.stageActionsGroup, compact && styles.stageActionsGroupCompact]}>
                {canEditTask && !editingThisTask ? <Button size="sm" variant="outline" disabled={busy} onPress={() => { setTaskEditing(true); setTaskEditBase({ id: task.id, title: task.title, description: task.description }); setEditTaskTitle(task.title); setEditTaskDescription(task.description || ""); setActionError(null); }}>Редактировать</Button> : null}
                {canManageTask ? <Button size="sm" variant="outline" disabled={busy} onPress={() => setManageOpen(true)}>Участники и исполнители</Button> : null}
              </View> : null}
              <View style={[styles.stageActionsGroup, styles.stageActionsRight, compact && styles.stageActionsGroupCompact]}>
                <Button size="sm" variant="ghost" disabled={busy} onPress={() => router.push(`/projects/${id}/tasks/${taskId}/history` as never)}>История</Button>
                <View accessibilityElementsHidden style={[styles.actionDivider, { backgroundColor: theme.border }]} />
                <Button size="sm" variant="ghost" disabled={busy} onPress={() => router.push(`/projects/${id}/tasks/${taskId}/progress` as never)}>Прогресс дня</Button>
              </View>
            </View>
            {canRestore ? <View style={styles.actions}><Button disabled={busy} loading={busyAction === "restore"} onPress={() => void run(() => restoreTask(taskId), "restore")}>Восстановить этап</Button><Button variant="destructive" disabled={busy} onPress={() => { setActionError(null); setHardDeleteConfirm(true); }}>Удалить навсегда</Button></View> : null}
            {!canUpdateChecklistProgress ? <View style={[styles.notice, { backgroundColor: theme.surfaceMuted }]}><ThemedText type="small">{project?.status === "archived" ? "Проект в архиве. Этап доступен для просмотра." : task.status === "archived" ? "Этап в архиве. Для продолжения работы восстановите его." : effectiveTaskRole === "viewer" ? "Для чек-листа этого этапа у вас доступ только для просмотра." : hasTaskAccess ? "Прогресс чек-листа сейчас недоступен." : "Нет доступа к этапу."}</ThemedText></View> : null}
            <Card muted>
              <View style={styles.sectionHead}><ThemedText type="h2">Обзор этапа</ThemedText><View style={styles.badges}>
                {effectiveTaskRole ? <Badge tone="primary">{projectRoleLabels[effectiveTaskRole]}</Badge> : null}
                <TaskStatus status={progressStatus(progress, task.status === 'archived')} />
                <DeadlineBadge state={task.status === 'archived' ? 'normal' : deadlineSummary(activeItems, now).state} />
              </View></View>
              <Progress
                value={progress}
                label={activeItems.length ? `${completedItems} из ${activeItems.length} пунктов выполнено` : "Добавьте пункты, чтобы отслеживать выполнение"}
              />
              <ThemedText type="small">{assigneeNames.length ? `${russianCount(assigneeNames.length, ["исполнитель", "исполнителя", "исполнителей"])}: ${assigneeNames.join(", ")}` : "Исполнители пока не назначены"}</ThemedText>
            </Card>
            <View style={[styles.sectionHead, compact && styles.checklistHeadCompact]}>
              <View style={[styles.sectionTitle, compact && styles.checklistTitleCompact]}><ThemedText type="h2">Чек-лист</ThemedText><ThemedText type="small">{showArchivedItems ? "Архивные пункты доступны для просмотра." : "Отмечайте готовые пункты или уточняйте прогресс в деталях."}</ThemedText></View>
              {hasTaskAccess ? <SegmentedControl value={currentView} accessibilityLabel="Пункты чек-листа" options={[{ value: "active", label: "Активные" }, { value: "archived", label: "Архив" }]} onChange={(value) => { if (busy) return; setShowArchivedItems(value === "archived"); setExpandedItem(null); setEditing(null); setCommentEditing(null); setActionError(null); }} /> : null}
            </View>
            {loadedView !== currentView ? (loadError ? <View style={styles.feedback}><ThemedText type="small">Выбранный список пунктов не загрузился.</ThemedText><Button size="sm" variant="outline" onPress={() => void refreshFromServer()}>Повторить</Button></View> : <LoadingState label={showArchivedItems ? "Загружаем архив…" : "Загружаем чек-лист…"} />) : !visibleItems.length ? (
              <EmptyState
                title={showArchivedItems ? "Архив чек-листа пуст" : "Чек-лист пуст"}
                description={showArchivedItems ? "Здесь появятся пункты после архивации." : canEditChecklist ? "Добавьте первый пункт, чтобы разбить этап на последовательные шаги." : "Участники проекта ещё не добавили пункты в этот этап."}
              />
            ) : (
              <View style={styles.list} onLayout={(event) => { listTop.current = event.nativeEvent.layout.y; }}>
                {visibleItems.map((item, index) => {
                  const percentageRaw = editPercentage[item.id] ?? String(item.percentage);
                  const parsedPercentage = parsePercentageInput(percentageRaw);
                  const percentageSaveValid = parsedPercentage !== null && parsedPercentage !== item.percentage;
                  const formattedComment = formatChecklistComment(item.comment);
                  const conflictingDraft = (editing === item.id && draftVersion(item, 'title') !== item.sync_version)
                    || (commentEditing === item.id && draftVersion(item, 'comment') !== item.sync_version)
                    || (editPercentage[item.id] !== undefined && draftVersion(item, 'percentage') !== item.sync_version);
                  return (
                  <DeadlineCard state={task.status === 'archived' ? 'normal' : deadlineState(item, now)} key={item.id} muted={item.is_archived} onLayout={(event) => {
                    linkedPositions.current.set(item.id, event.nativeEvent.layout.y);
                    if (linkedItem === item.id) requestAnimationFrame(() => scrollRef.current?.scrollTo({ y: Math.max(0, listTop.current + (linkedPositions.current.get(item.id) ?? 0) - 16), animated: false }));
                  }}>
                    <ChecklistDeadline item={task.status === 'archived' ? { ...item, is_archived: true } : item} now={now} />
                    <View style={styles.itemRow}>
                      <Checkbox
                        checked={item.is_completed}
                        disabled={busy || !canUpdateChecklistProgress || item.is_archived}
                        label={`${item.title}, ${item.is_completed ? "выполнено" : "не выполнено"}`}
                        onPress={() =>
                           void runItemEdit(item, { type: 'set_task_item_state', payload: { completed: !item.is_completed } }, () => setTaskItemState(item.id, !item.is_completed, item.sync_version))
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
                             onPress={() => void runItemEdit(item, { type: 'set_task_item_state', payload: { completed: !item.is_completed } }, () => setTaskItemState(item.id, !item.is_completed, item.sync_version))}
                            style={({ pressed }) => [styles.titleToggle, pressed && styles.pressed]}
                          >
                            <ThemedText style={item.is_completed ? [styles.completed, { color: theme.textMuted }] : undefined}>
                              {index + 1}. {item.title}
                            </ThemedText>
                          </Pressable>
                        )}
                        {formattedComment ? <ThemedText type="small" style={styles.itemComment}>{formattedComment}</ThemedText> : null}
                        {conflictingDraft ? <View><ErrorMessage message={`Пункт изменён другим участником. Сейчас: «${item.title}», ${item.percentage}%, комментарий: ${item.comment || 'нет'}. Ваш ввод сохранён.`} /><Button size="sm" variant="outline" disabled={busy} onPress={() => setDraftVersions((old) => ({ ...old, [`${item.id}:title`]: item.sync_version, [`${item.id}:comment`]: item.sync_version, [`${item.id}:percentage`]: item.sync_version }))}>Продолжить с моим черновиком пункта</Button></View> : null}
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
                    {item.description ? <ThemedText type="small">{item.description}</ThemedText> : null}
                    <Progress value={item.percentage} label="Выполнение пункта" />
                    {commentEditing === item.id ? <View style={styles.commentEditor}>
                      <Textarea label="Комментарий к пункту" value={editComment} onChangeText={setEditComment} maxLength={10000} placeholder="Необязательно" disabled={busy} />
                       <View style={styles.actions}><Button size="sm" loading={busyAction === item.id} disabled={busy || editComment.length > 10000 || draftVersion(item, 'comment') !== item.sync_version} onPress={() => void runItemEdit(item, { type: 'set_task_item_comment', payload: { comment: editComment } }, () => setTaskItemComment(item.id, editComment, draftVersion(item, 'comment')), () => setCommentEditing(null), draftVersion(item, 'comment'))}>Сохранить комментарий</Button><Button size="sm" variant="outline" disabled={busy} onPress={() => setCommentEditing(null)}>Отмена</Button></View>
                    </View> : null}
                    {canUpdateChecklistProgress && !item.is_archived && editing !== item.id && commentEditing !== item.id ? <View style={styles.progressEditor}>
                      <View style={styles.percentageField}><Input label="Прогресс, от 1 до 100%" value={percentageRaw} onChangeText={(value) => { setDraftVersions((old) => ({ ...old, [`${item.id}:percentage`]: old[`${item.id}:percentage`] ?? item.sync_version })); setEditPercentage((current) => ({ ...current, [item.id]: value })); }} keyboardType="numeric" maxLength={7} onSubmitEditing={() => savePercentage(item)} disabled={busy} /></View>
                      <Button size="sm" variant={percentageSaveValid ? "primary" : "secondary"} loading={busyAction === item.id} disabled={busy || !percentageSaveValid || draftVersion(item, 'percentage') !== item.sync_version} onPress={() => savePercentage(item)}>Сохранить прогресс</Button>
                    </View> : null}
                    {canUpdateChecklistProgress && !item.is_archived ? <View style={styles.actions}>
                      <Button size="sm" variant="outline" disabled={busy || offlineForEdits || pendingItemIds.has(item.id)} onPress={() => { setActionError(null); setDeadlineConflict(null); setDeadlineEditing(item); }}>{item.deadline_at ? 'Изменить дедлайн' : 'Установить дедлайн'}</Button>
                      {item.deadline_at ? <Button size="sm" variant="ghost" disabled={busy || offlineForEdits || pendingItemIds.has(item.id)} onPress={() => setConfirm({ title: 'Удалить дедлайн?', description: 'Активные предупреждения исчезнут. История уведомлений сохранится.', confirmLabel: 'Удалить дедлайн', target: item.id, action: () => setTaskItemDeadline(item.id, null, item.sync_version) })}>Удалить дедлайн</Button> : null}
                      {offlineForEdits || pendingItemIds.has(item.id) ? <ThemedText type="caption">Изменение дедлайна доступно после подключения и синхронизации чек-листа.</ThemedText> : null}
                    </View> : null}

                    {editing === item.id && canEditChecklist ? (
                      <View style={styles.actions}>
                        <Button
                          size="sm"
                          loading={busyAction === item.id}
                          disabled={busy || !editTitle.trim() || draftVersion(item, 'title') !== item.sync_version}
                          onPress={() =>
                            void run(async () => {
                              try { await updateTaskItem(item.id, editTitle.trim(), draftVersion(item, 'title')); }
                              catch (error) { if ((error as { code?: string })?.code === 'PT409') await load(); throw error; }
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
                      <View style={styles.actions}><Button size="sm" variant="destructive" disabled={busy} onPress={() => { setActionError(null); setItemToDelete(item); }}>Удалить навсегда</Button></View>
                    ) : canUpdateChecklistProgress && !item.is_archived && commentEditing !== item.id ? (
                      <View style={styles.actions}>
                        {canEditChecklist ? <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onPress={() => {
                            setEditing(item.id);
                            setDraftVersions((old) => ({ ...old, [`${item.id}:title`]: item.sync_version }));
                            setEditTitle(item.title);
                          }}
                        >
                          Изменить текст
                        </Button> : null}
                        <Button size="sm" variant="ghost" disabled={busy} onPress={() => { setCommentEditing(item.id); setEditComment(item.comment || ""); setDraftVersions((old) => ({ ...old, [`${item.id}:comment`]: item.sync_version })); }}>
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
                  </DeadlineCard>
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
            {canManageTask ? <View style={[styles.taskFooter, { borderTopColor: theme.border }]}><ThemedText type="small" style={styles.footerCopy}>Этап больше не нужен в текущей работе?</ThemedText><Button size="sm" variant="destructive" disabled={busy} onPress={() => setConfirm({ title: "Архивировать этап?", description: "Этап переместится в архив проекта. Его можно будет восстановить вместе с чек-листом.", action: () => archiveTask(taskId), confirmLabel: "Архивировать", destructive: false })}>Архивировать этап</Button></View> : null}
            {task && canManageTask && manageOpen ? (
              <ModalLayer visible busy={busy} onClose={() => setManageOpen(false)} label="Участники и исполнители">
                <View style={[styles.modalSheet, !compact && styles.modalSheetDesktop, { backgroundColor: theme.surface, paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
                  <View style={styles.sectionHead}><View style={styles.flex}><ThemedText type="h2">Участники и исполнители</ThemedText><ThemedText type="small" numberOfLines={2}>{task.title}</ThemedText></View><Button size="sm" variant="ghost" disabled={busy} onPress={() => setManageOpen(false)}>Закрыть</Button></View>
                  <ScrollView style={styles.modalScroll} contentContainerStyle={styles.modalContent} keyboardShouldPersistTaps="handled">
                    <TaskMembersPanel taskId={taskId} userId={user.id} projectRole={project?.role ?? null} participants={participants} assignees={assignees} busy={busy} error={actionError?.target === 'members' ? actionError.message : undefined} run={run} />
                  </ScrollView>
                </View>
              </ModalLayer>
            ) : null}
          </>
        )}
      </ScrollView>
      {deadlineEditing ? <DeadlinePicker value={deadlineEditing.deadline_at} busy={busy}
        error={actionError?.target === deadlineEditing.id ? actionError.message : undefined}
        onCancel={() => { if (!busy) { setDeadlineEditing(null); setDeadlineConflict(null); setActionError(null); } }}
        onResolveConflict={deadlineConflict ? () => { setDeadlineEditing(deadlineConflict); setDeadlineConflict(null); setActionError(null); } : undefined}
        conflictDeadline={deadlineConflict?.deadline_at}
        onSave={async (value) => {
          const saved = await run(async () => {
            try { await setTaskItemDeadline(deadlineEditing.id, value, deadlineEditing.sync_version); }
            catch (error) {
              if ((error as { code?: string })?.code === 'PT409') {
                setDeadlineConflict(await getTaskItemForEdit(deadlineEditing.id));
              }
              throw error;
            }
          }, deadlineEditing.id);
          if (saved) setDeadlineEditing(null);
        }} /> : null}
      <ConfirmDialog
        visible={Boolean(confirm)}
        title={confirm?.title || ""}
        description={confirm?.description || ""}
        confirmLabel={confirm?.confirmLabel || "Подтвердить"}
        error={actionError?.target === (confirm?.target ?? 'task') ? actionError.message : undefined}
        destructive={confirm?.destructive ?? true}
        busy={busy}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void confirmAction()}
      />
      <ConfirmDialog visible={hardDeleteConfirm} title="Удалить этап навсегда?" description="Архивный этап и его чек-лист будут удалены без возможности восстановления." confirmLabel="Удалить навсегда" busy={busy} error={actionError?.target === 'task' ? actionError.message : undefined} onCancel={() => { setHardDeleteConfirm(false); setActionError(null); }} onConfirm={() => void hardDelete()} />
      <ConfirmDialog visible={Boolean(itemToDelete)} title="Удалить пункт навсегда?" description="Архивный пункт чек-листа будет удалён без возможности восстановления." confirmLabel="Удалить навсегда" busy={busy} error={actionError?.target === itemToDelete?.id ? actionError?.message : undefined} onCancel={() => { setItemToDelete(null); setActionError(null); }} onConfirm={() => { const item = itemToDelete; if (item) void run(async () => { await hardDeleteTaskItem(item.id); setItemToDelete(null); }, item.id); }} />
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
  badges: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, alignItems: "center", maxWidth: "100%", minWidth: 0 },
  sectionTitle: { flex: 1, minWidth: 0, gap: spacing.xs },
  checklistHeadCompact: { flexDirection: 'column', alignItems: 'stretch' },
  checklistTitleCompact: { flex: 0 },
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
  flex: { flex: 1, minWidth: 0 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  stageActions: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: spacing.md },
  stageActionsCompact: { alignItems: "stretch" },
  stageActionsGroup: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm, maxWidth: "100%", minWidth: 0 },
  stageActionsGroupCompact: { width: "100%", marginLeft: 0, justifyContent: 'flex-start' },
  stageActionsRight: { marginLeft: "auto", justifyContent: "flex-end" },
  actionDivider: { width: 1, height: 44, marginHorizontal: spacing.xs },
  taskFooter: { borderTopWidth: 1, paddingTop: spacing.md, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
  footerCopy: { flex: 1, minWidth: 140 },
  modalSheet: { width: "100%", maxWidth: 780, maxHeight: "100%", padding: spacing.lg, gap: spacing.md, borderTopLeftRadius: 16, borderTopRightRadius: 16, zIndex: 1, elevation: 1 },
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
