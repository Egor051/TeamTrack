import { useCallback, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, router } from "expo-router";
import { Screen } from "@/components/ui/screen";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { ThemedText } from "@/components/ui/text";
import {
  listTaskHistory,
  listTaskAudit,
  listTaskItems,
  listProjectMembers,
  type ItemAction,
  type AuditEntry,
  type TaskItem,
  type ProjectMember,
} from "@/features/projects/projects";
import { subscribeMany, type RealtimeStatus } from "@/lib/supabase/realtime";
import { userMessage } from "@/lib/errors/user-message";
import { colors, layout, spacing } from "@/components/ui/theme";

export default function History() {
  const { id, taskId } = useLocalSearchParams<{ id: string; taskId: string }>();
  const [actions, setActions] = useState<ItemAction[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [items, setItems] = useState<TaskItem[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const [details, setDetails] = useState<number | null>(null);
  const requestRef = useRef(0);
  const realtimeConnectedRef = useRef(false);
  const load = useCallback(async () => {
    if (!id || !taskId) return;
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const [a, au, it, ms] = await Promise.all([
        listTaskHistory(taskId),
        listTaskAudit(id, taskId),
        listTaskItems(taskId, true),
        listProjectMembers(id),
      ]);
      if (request !== requestRef.current) return;
      setActions(a);
      setAudit(au);
      setItems(it);
      setMembers(ms);
      setError("");
    } catch (e) {
      if (request === requestRef.current)
        setError(userMessage(e, "Не удалось загрузить историю."));
    } finally {
      if (request === requestRef.current) setLoading(false);
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
      if (!id || !taskId) return;
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
    }, [id, taskId, load]),
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
  return (
    <Screen padded={false} centerContent={false}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <PageHeader
          title="История задачи"
          subtitle="Изменения чек-листа и системные события"
          onBack={() => router.back()}
          actions={
            <ThemedText type="caption">
              Синхронизация: {status === "connected" ? "готова" : status}
            </ThemedText>
          }
        />
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : loading ? (
          <LoadingState label="Загружаем историю..." />
        ) : !actions.length && !audit.length ? (
          <EmptyState
            title="История пуста"
            description="Здесь появятся действия пользователей и изменения задачи."
          />
        ) : (
          <>
            <ThemedText type="h2">Чек-лист</ThemedText>
            {actions.map((a) => (
              <Card key={a.id}>
                <View style={styles.row}>
                  <Badge tone={a.action === "checked" ? "success" : "warning"}>
                    {a.action === "checked" ? "Выполнено" : "Снято"}
                  </Badge>
                  <View style={styles.flex}>
                    <ThemedText type="h3">
                      {itemName.get(a.task_item_id) || "Пункт чек-листа"}
                    </ThemedText>
                    <ThemedText type="small">
                      {memberName.get(a.user_id) || "Пользователь"} ·{" "}
                      {fmt(a.created_at)}
                    </ThemedText>
                  </View>
                </View>
              </Card>
            ))}
            <ThemedText type="h2">Журнал действий</ThemedText>
            {audit.map((a) => (
              <Card key={a.id}>
                <View style={styles.row}>
                  <Badge tone="neutral">{a.action}</Badge>
                  <View style={styles.flex}>
                    <ThemedText type="small">
                      {a.entity_type} ·{" "}
                      {memberName.get(a.user_id || "") || "Система"} ·{" "}
                      {fmt(a.created_at)}
                    </ThemedText>
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={() => setDetails(details === a.id ? null : a.id)}
                    >
                      {details === a.id ? "Скрыть детали" : "Показать детали"}
                    </Button>
                    {details === a.id ? (
                      <ThemedText type="caption" style={styles.technical}>
                        {[
                          a.old_data && `До: ${JSON.stringify(a.old_data)}`,
                          a.new_data && `После: ${JSON.stringify(a.new_data)}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </ThemedText>
                    ) : null}
                  </View>
                </View>
              </Card>
            ))}
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
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  flex: { flex: 1 },
  technical: { color: colors.textMuted, marginTop: spacing.sm },
});
