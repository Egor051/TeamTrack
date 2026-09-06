import { useCallback, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Screen } from "@/components/ui/screen";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { ThemedText } from "@/components/ui/text";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  getProject,
  listProjectMembers,
  addProjectMemberByIdentifier,
  changeMemberRole,
  removeProjectMember,
  type ProjectMember,
  type ProjectRole,
} from "@/features/projects/projects";
import { userMessage } from "@/lib/errors/user-message";
import { layout, spacing } from "@/components/ui/theme";
import { useTheme } from "@/components/ui/theme-provider";
const roles: ProjectRole[] = ["admin", "member", "viewer"];
const roleLabels: Record<ProjectRole, string> = { owner: "Владелец", admin: "Администратор", member: "Участник", viewer: "Наблюдатель" };
const roleDescriptions: Record<ProjectRole, string> = {
  owner: "Полный контроль над проектом. Может управлять участниками, ролями, задачами и передавать владение проектом.",
  admin: "Может управлять участниками проекта, доступом к задачам, исполнителями и архивированием. Не может передавать владение проектом и менять права другого администратора.",
  member: "Может работать с доступными ему задачами и изменять чек-лист. Не может управлять участниками проекта, ролями и глобальными настройками проекта.",
  viewer: "Может просматривать доступные данные, но не может изменять задачи и чек-лист.",
};
export default function MembersScreen() {
  const { colors: theme } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [currentRole, setCurrentRole] = useState<ProjectRole | null>(null);
  const [projectStatus, setProjectStatus] = useState<
    "active" | "archived" | null
  >(null);
  const [newRole, setNewRole] = useState<ProjectRole>("member");
  const [identifier, setIdentifier] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [remove, setRemove] = useState<ProjectMember | null>(null);
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    if (!id) return;
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const p = await getProject(id);
      const nextMembers = await listProjectMembers(id);
      if (request !== requestRef.current) return;
      setCurrentRole(p.role);
      setProjectStatus(p.status);
      setMembers(nextMembers);
      setError("");
    } catch (e) {
      if (request === requestRef.current)
        setError(userMessage(e, "Не удалось загрузить участников."));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [id]);
  useFocusEffect(
    useCallback(() => {
      void load();
      return () => {
        requestRef.current += 1;
      };
    }, [load]),
  );
  const canManage =
    (currentRole === "owner" || currentRole === "admin") &&
    projectStatus === "active";
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (e) {
      setError(userMessage(e, "Операция не выполнена."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Screen padded={false} centerContent={false}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <PageHeader
          title="Участники"
          subtitle="Доступ к проекту"
          onBack={() => router.back()}
        />
        {error ? (
          <ErrorState message={error} onRetry={load} />
        ) : loading ? (
          <LoadingState label="Загружаем участников..." />
        ) : !members.length ? (
          <EmptyState
            title="Участников нет"
            description="В проекте пока нет участников."
          />
        ) : (
          <View style={styles.list}>
            {members.map((m) => (
              <Card key={m.user_id}>
                <View style={styles.row}>
                  <View style={styles.flex}>
                    <ThemedText type="h3">
                      {m.profile?.display_name || m.user_id.slice(0, 8)}
                    </ThemedText>
                    <ThemedText type="small">
                      Добавлен{" "}
                      {new Date(m.joined_at).toLocaleDateString("ru-RU")}
                    </ThemedText>
                  </View>
                  <Badge tone={m.role === "owner" ? "primary" : "neutral"}>
                    {roleLabels[m.role]}
                  </Badge>
                </View>
                {canManage && m.role !== "owner" ? (
                  <View style={styles.actions}>
                    {(["admin", "member", "viewer"] as ProjectRole[]).filter((role) => role !== m.role).map((role) => <Button key={role} size="sm" variant="outline" disabled={busy || (currentRole === "admin" && m.role === "admin")} onPress={() => void run(() => changeMemberRole(id!, m.user_id, role))}>{roleLabels[role]}</Button>)}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onPress={() => setRemove(m)}
                    >
                      Удалить
                    </Button>
                  </View>
                ) : null}
              </Card>
            ))}
          </View>
        )}
      {canManage ? (
        <Card>
          <ThemedText type="h2">Роли и права</ThemedText>
          {(Object.keys(roleLabels) as ProjectRole[]).map((role) => <View key={role} style={{ gap: spacing.xs }}><ThemedText type="h3">{roleLabels[role]}</ThemedText><ThemedText type="small" style={[styles.roleDescription, { color: theme.textSecondary }]}>{roleDescriptions[role]}</ThemedText></View>)}
        </Card>
      ) : null}
      {canManage ? (
          <Card>
            <ThemedText type="h2">Добавить участника</ThemedText>
            <ThemedText type="small">
              Укажите email или ник пользователя и роль доступа.
            </ThemedText>
            <Input
              label="Email или ник"
              placeholder="user@example.com или username"
              value={identifier}
              onChangeText={setIdentifier}
            />
            <View style={styles.actions}>
              {roles.map((r) => (
                <Button
                  key={r}
                  size="sm"
                  variant={newRole === r ? "primary" : "outline"}
                  onPress={() => setNewRole(r)}
                >
                  {roleLabels[r]}
                </Button>
              ))}
            </View>
            <ThemedText type="small" style={[styles.roleDescription, { color: theme.textSecondary }]}>{roleDescriptions[newRole]}</ThemedText>
            <Button
              loading={busy}
              disabled={!identifier.trim()}
              onPress={() =>
                void run(async () => {
                  await addProjectMemberByIdentifier(
                    id!,
                    identifier.trim(),
                    newRole,
                  );
                  setIdentifier("");
                })
              }
            >
              Добавить
            </Button>
          </Card>
        ) : null}
      </ScrollView>
      <ConfirmDialog
        visible={Boolean(remove)}
        title="Удалить участника?"
        description={`${remove?.profile?.display_name || "Пользователь"} потеряет доступ к проекту.`}
        confirmLabel="Удалить"
        busy={busy}
        onCancel={() => setRemove(null)}
        onConfirm={() => {
          if (remove) {
            setRemove(null);
            void run(() => removeProjectMember(id!, remove.user_id));
          }
        }}
      />
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
  list: { gap: spacing.md },
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  flex: { flex: 1, minWidth: 160 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  roleDescription: {},
});
