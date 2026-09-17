import { useCallback, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useFocusEffect, useLocalSearchParams, router } from "expo-router";
import { Screen } from "@/components/ui/screen";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { ThemedText } from "@/components/ui/text";
import { RealtimeIndicator } from "@/components/ui/realtime-indicator";
import { ErrorMessage } from "@/components/ui/error-message";
import {
  listTaskAudit,
  listTaskItems,
  listProjectMembers,
  getTask,
  getProject,
  type AuditEntry,
  type TaskItem,
  type ProjectMember,
} from "@/features/projects/projects";
import { subscribeMany, type RealtimeStatus } from "@/lib/supabase/realtime";
import { userMessage } from "@/lib/errors/user-message";
import { layout, spacing } from "@/components/ui/theme";
import { useTheme } from "@/components/ui/theme-provider";
import { usePermissionVersion } from "@/features/auth/PermissionProvider";
import { ResourceAccessDeniedError } from "@/lib/errors/domain-errors";
import { formatAuditChanges, selectChecklistHistory } from "@/features/projects/history-format";

const auditActionLabels: Record<string, string> = {
  created: "Создание", updated: "Обновление", checked: "Выполнено", unchecked: "Отметка снята",
  archived: "Архивация", restored: "Восстановление", removed: "Удаление", reordered: "Изменение порядка",
  access_approved: "Доступ предоставлен", access_revoked: "Доступ отозван", assigned: "Назначение исполнителя",
  unassigned: "Назначение снято", role_changed: "Роль изменена", ownership_transferred: "Владение передано",
};
const entityLabels: Record<string, string> = {
  task: "Этап", task_item: "Пункт чек-листа", task_member: "Участник этапа",
  task_assignee: "Исполнитель", project: "Проект", project_member: "Участник проекта", profile: "Профиль",
};
const extraFieldLabels: Record<string, string> = {
  status: "статус", name: "название", role: "роль", user_id: "участник", approved_by: "кто предоставил доступ",
  approved_at: "дата предоставления доступа", assigned_by: "кто назначил исполнителя", assigned_at: "дата назначения",
  display_name: "имя пользователя", owner_id: "владелец", created_by: "автор",
};
function readableAuditChanges(entry: AuditEntry) {
  return formatAuditChanges(entry.old_data, entry.new_data).flatMap((change) => {
    const match = /^Изменено: ([a-z_]+)$/.exec(change);
    if (!match) return [change];
    const label = extraFieldLabels[match[1]];
    return [label ? `Изменено: ${label}` : change];
  });
}

export default function History() {
  const { colors: theme } = useTheme();
  const { width } = useWindowDimensions();
  const { id, taskId } = useLocalSearchParams<{ id: string; taskId: string }>();
  const permissionVersion = usePermissionVersion();
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [items, setItems] = useState<TaskItem[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [taskTitle, setTaskTitle] = useState("");
  const [projectName, setProjectName] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const [details, setDetails] = useState<number | null>(null);
  const [actionLogExpanded, setActionLogExpanded] = useState(false);
  const requestRef = useRef(0);
  const realtimeConnectedRef = useRef(false);
  const load = useCallback(async () => {
    if (!id || !taskId) return;
    const request = ++requestRef.current;
    setLoading(true);
    setError("");
    try {
      const [au, it, ms, task, project] = await Promise.all([
        listTaskAudit(id, taskId),
        listTaskItems(taskId, "all"),
        listProjectMembers(id),
        getTask(taskId, id),
        getProject(id),
      ]);
      if (request !== requestRef.current) return;
      setAudit(au);
      setItems(it);
      setMembers(ms);
      setTaskTitle(task.title);
      setProjectName(project.name);
      setLoaded(true);
      setError("");
    } catch (e) {
      if (request === requestRef.current)
        setError(userMessage(e, "Не удалось загрузить историю."));
      if (request === requestRef.current && e instanceof ResourceAccessDeniedError) {
        setAudit([]);
        setItems([]);
        setMembers([]);
        setLoaded(false);
        router.replace("/projects" as never);
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [id, taskId]);
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
          table: "item_actions",
          options: { taskId, onEvent: () => void load(), onStatus },
        },
        {
          table: "audit_log",
          options: {
            projectId: id,
            onEvent: () => void load(),
            onStatus,
          },
        },
      ]);
    }, [id, taskId, load, permissionVersion]),
  );
  const fmt = (v: string) =>
    new Date(v).toLocaleString("ru-RU", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  const itemName = new Map(items.map((i) => [i.id, i.title]));
  const memberName = new Map(
    members.map((m) => [
      m.user_id,
      m.profile?.display_name || m.user_id.slice(0, 8),
    ]),
  );
  const checklistHistory = selectChecklistHistory(audit);
  const checklistActionLabels: Record<string, string> = {
    created: "Создан",
    updated: "Изменён",
    reordered: "Порядок изменён",
    checked: "Выполнено",
    unchecked: "Снято",
    archived: "Архивирован",
    restored: "Восстановлен",
    removed: "Удалён",
  };
  return (
    <Screen padded={false} centerContent={false}>
      <ScrollView
        contentContainerStyle={[styles.content, width < 700 && styles.compactContent]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} tintColor={theme.primary} />}
      >
        <PageHeader
          title="История этапа"
          subtitle={taskTitle || "Изменения чек-листа и действия участников"}
          onBack={() => router.replace(`/projects/${id}/tasks/${taskId}` as never)}
          backLabel="К этапу"
          breadcrumbs={[{ label: "Проекты", href: "/projects" }, { label: projectName || "Проект", href: `/projects/${id}` }, { label: taskTitle || "Этап", href: `/projects/${id}/tasks/${taskId}` }, { label: "История" }]}
          actions={<><RealtimeIndicator status={status} /><Button size="sm" variant="outline" loading={loading} disabled={loading} onPress={() => void load()}>Обновить</Button></>}
        />
        {error && loaded ? <Card><ErrorMessage message={error} type="generic" /><Button size="sm" variant="outline" onPress={() => void load()}>Обновить историю</Button></Card> : null}
        {error && !loaded ? (
          <ErrorState message={error} onRetry={load} />
        ) : loading && !loaded ? (
          <LoadingState label="Загружаем историю..." />
        ) : !checklistHistory.length && !audit.length ? (
          <EmptyState
            title="История пуста"
            description="Здесь появятся действия пользователей и изменения этапа."
          />
        ) : (
          <>
            <View style={styles.sectionTitle}><ThemedText type="h2">Изменения чек-листа</ThemedText><ThemedText type="small">Новые события отображаются первыми.</ThemedText></View>
            {!checklistHistory.length ? <ThemedText type="small">Изменений пунктов пока нет.</ThemedText> : null}
            {checklistHistory.map((entry) => (
              <Card key={entry.id}>
                <View style={styles.entry}>
                  <Badge tone={entry.action === "checked" ? "success" : entry.action === "unchecked" ? "warning" : entry.action === "archived" || entry.action === "removed" ? "neutral" : "primary"}>
                    {checklistActionLabels[entry.action] || "Изменён"}
                  </Badge>
                  <View style={styles.flex}>
                    <ThemedText type="h3">
                      {itemName.get(entry.taskItemId) || entry.itemTitle || "Пункт чек-листа"}
                    </ThemedText>
                    <ThemedText type="small">
                      {memberName.get(entry.userId || "") || (entry.userId ? entry.userId.slice(0, 8) : "Система")} · {fmt(entry.createdAt)}
                    </ThemedText>
                    {entry.changes.map((change) => <ThemedText key={change} type="small">{change}</ThemedText>)}
                  </View>
                </View>
              </Card>
            ))}
            <View style={styles.sectionHeader}>
              <ThemedText type="h2">Журнал действий</ThemedText>
              <Button
                size="sm"
                variant="ghost"
                accessibilityLabel={actionLogExpanded ? "Свернуть журнал действий" : "Развернуть журнал действий"}
                accessibilityState={{ expanded: actionLogExpanded }}
                onPress={() => setActionLogExpanded((expanded) => !expanded)}
              >
                {actionLogExpanded ? "Свернуть" : "Развернуть"}
              </Button>
            </View>
            {actionLogExpanded && !audit.length ? <ThemedText type="small">В журнале пока нет событий.</ThemedText> : null}
            {actionLogExpanded ? audit.map((a) => (
              <Card key={a.id}>
                <View style={styles.entry}>
                  <Badge tone="neutral">{auditActionLabels[a.action] || "Изменение"}</Badge>
                  <View style={styles.flex}>
                    <ThemedText type="small">
                      {entityLabels[a.entity_type] || "Объект"} ·{" "}
                      {memberName.get(a.user_id || "") || (a.user_id ? a.user_id.slice(0, 8) : "Система")} ·{" "}
                      {fmt(a.created_at)}
                    </ThemedText>
                    {readableAuditChanges(a).map((summary) => <ThemedText key={summary} type="small">{summary}</ThemedText>)}
                    <Button
                      size="sm"
                      variant="ghost"
                      accessibilityState={{ expanded: details === a.id }}
                      onPress={() => setDetails(details === a.id ? null : a.id)}
                    >
                      {details === a.id ? "Скрыть технические детали" : "Технические детали"}
                    </Button>
                    {details === a.id ? (
                      <ThemedText selectable type="caption" style={[styles.technical, { color: theme.textMuted, backgroundColor: theme.surfaceMuted }]}>
                        {[
                          `Событие: ${a.action} · ${a.entity_type}`,
                          a.old_data && `До: ${JSON.stringify(a.old_data)}`,
                          a.new_data && `После: ${JSON.stringify(a.new_data)}`,
                        ]
                          .filter(Boolean)
                          .join("\n\n")}
                      </ThemedText>
                    ) : null}
                  </View>
                </View>
              </Card>
            )) : null}
          </>
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
  sectionTitle: { gap: spacing.xs },
  entry: { alignItems: "flex-start", gap: spacing.md },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: spacing.md },
  flex: { width: "100%", minWidth: 0, gap: spacing.xs },
  technical: { marginTop: spacing.sm, padding: spacing.md, borderRadius: 8 },
});
