import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Screen } from '@/components/ui/screen';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { ErrorMessage } from '@/components/ui/error-message';
import { ThemedText } from '@/components/ui/text';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { usePermissionVersion } from '@/features/auth/PermissionProvider';
import { ResourceAccessDeniedError } from '@/lib/errors/domain-errors';
import {
  getProject,
  listProjectMembers,
  addProjectMemberByIdentifier,
  changeMemberRole,
  removeProjectMember,
  type ProjectMember,
  type ProjectRole,
} from '@/features/projects/projects';
import { userMessage } from '@/lib/errors/user-message';
import { layout, spacing } from '@/components/ui/theme';
import { useTheme } from '@/components/ui/theme-provider';

const roles: ProjectRole[] = ['admin', 'member', 'viewer'];
const roleLabels: Record<ProjectRole, string> = { owner: 'Владелец', admin: 'Администратор', member: 'Участник', viewer: 'Наблюдатель' };
const roleDescriptions: Record<ProjectRole, string> = {
  owner: 'Полный контроль над проектом: участники, роли, задачи и передача владения.',
  admin: 'Управляет участниками, доступом к задачам, исполнителями и архивированием. Не может передавать владение и менять права другого администратора.',
  member: 'Работает с доступными ему задачами и изменяет чек-листы. Не может управлять участниками и ролями проекта.',
  viewer: 'Просматривает доступные данные. Не может изменять задачи и чек-листы.',
};
const roleOptions = roles.map((role) => ({ value: role, label: roleLabels[role] }));

export default function MembersScreen() {
  const { colors: theme } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const permissionVersion = usePermissionVersion();
  const [projectName, setProjectName] = useState('Проект');
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [currentRole, setCurrentRole] = useState<ProjectRole | null>(null);
  const [projectStatus, setProjectStatus] = useState<'active' | 'archived' | null>(null);
  const [newRole, setNewRole] = useState<ProjectRole>('member');
  const [identifier, setIdentifier] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [editingMember, setEditingMember] = useState<string | null>(null);
  const [editingRole, setEditingRole] = useState<ProjectRole>('member');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const [remove, setRemove] = useState<ProjectMember | null>(null);
  const requestRef = useRef(0);
  const actionRef = useRef(false);

  const load = useCallback(async () => {
    if (!id) return;
    const request = ++requestRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const [project, nextMembers] = await Promise.all([getProject(id), listProjectMembers(id)]);
      if (request !== requestRef.current) return;
      setProjectName(project.name);
      setCurrentRole(project.role);
      setProjectStatus(project.status);
      setMembers(nextMembers);
      setLoadError('');
    } catch (e) {
      if (request === requestRef.current) setLoadError(userMessage(e, 'Не удалось загрузить участников.'));
      if (request === requestRef.current && e instanceof ResourceAccessDeniedError) router.replace('/projects');
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [id]);

  useFocusEffect(useCallback(() => {
    void permissionVersion;
    void load();
    return () => { requestRef.current += 1; };
  }, [load, permissionVersion]));

  const canManage = (currentRole === 'owner' || currentRole === 'admin') && projectStatus === 'active';

  async function run(key: string, action: () => Promise<unknown>, message: string) {
    if (actionRef.current) return;
    actionRef.current = true;
    setBusy(key);
    setActionError('');
    setSuccess('');
    try {
      try {
        await action();
      } catch (e) {
        setActionError(userMessage(e, 'Операция не выполнена. Попробуйте ещё раз.'));
        return;
      }
      setSuccess(message);
      try {
        await load();
      } catch (e) {
        setLoadError(userMessage(e, 'Не удалось обновить список участников.'));
      }
    } finally {
      actionRef.current = false;
      setBusy(null);
    }
  }

  return (
    <Screen scrollable centerContent={false} maxWidth={layout.readingMaxWidth} contentStyle={styles.content}>
        <PageHeader
          title="Участники"
          subtitle="Кто может работать в проекте и какие действия ему доступны."
          onBack={() => router.replace(`/projects/${id}` as never)}
          backLabel="К проекту"
          breadcrumbs={[{ label: 'Проекты', href: '/projects' }, { label: projectName, href: `/projects/${id}` }, { label: 'Участники' }]}
        actions={canManage && !showAdd ? <Button disabled={Boolean(busy)} onPress={() => { setShowAdd(true); setActionError(''); }}>Добавить участника</Button> : undefined}
      />
      {projectStatus === 'archived' ? (
        <Card muted><ThemedText type="small">Проект в архиве. Изменение состава участников и ролей недоступно.</ThemedText></Card>
      ) : null}
      {success ? <ThemedText accessibilityLiveRegion="polite" type="small" style={{ color: theme.success }}>{success}</ThemedText> : null}
      {actionError && !showAdd && !editingMember ? <ErrorMessage message={actionError} type="validation" /> : null}
      {canManage && showAdd ? (
        <Card style={styles.form}>
          <ThemedText type="h2">Добавить участника</ThemedText>
          <ThemedText type="small">Найдите пользователя по email или нику его аккаунта TaskTrace.</ThemedText>
          <Input
            label="Email или ник"
            placeholder="user@example.com или username"
            value={identifier}
            onChangeText={setIdentifier}
            autoCapitalize="none"
            autoCorrect={false}
            disabled={Boolean(busy)}
            autoFocus
          />
          <Select label="Роль в проекте" value={newRole} options={roleOptions} onChange={(role) => setNewRole(role as ProjectRole)} accessibilityLabel="Роль нового участника" disabled={Boolean(busy)} />
          <ThemedText type="small">{roleDescriptions[newRole]}</ThemedText>
          <ErrorMessage message={actionError} type="validation" />
          <View style={styles.actions}>
            <Button
              loading={busy === 'add'}
              disabled={Boolean(busy) || !identifier.trim()}
              onPress={() => void run('add', async () => {
                await addProjectMemberByIdentifier(id!, identifier.trim(), newRole);
                setIdentifier('');
                setShowAdd(false);
              }, 'Участник добавлен в проект.')}
            >Добавить в проект</Button>
            <Button variant="ghost" disabled={Boolean(busy)} onPress={() => { setShowAdd(false); setActionError(''); }}>Отмена</Button>
          </View>
        </Card>
      ) : null}
      {loadError && !members.length ? <ErrorState message={loadError} onRetry={load} /> : loading && !members.length ? <LoadingState label="Загружаем участников…" /> : !members.length ? (
        <EmptyState title="Участников пока нет" description="Добавьте людей, с которыми будете работать над проектом." />
      ) : (
        <>
          {loadError ? <View style={styles.feedback}><ErrorMessage message={loadError} type="generic" /><Button size="sm" variant="outline" onPress={() => void load()}>Обновить участников</Button></View> : null}
          <View style={styles.list}>
          <View style={styles.sectionHeader}>
            <ThemedText type="h2">Участники · {members.length}</ThemedText>
            {currentRole ? <ThemedText type="small">Ваша роль: {roleLabels[currentRole].toLowerCase()}</ThemedText> : null}
          </View>
          {members.map((member) => {
            const name = member.profile?.display_name || member.user_id.slice(0, 8);
            const isEditing = editingMember === member.user_id;
            const canChangeRole = canManage && member.role !== 'owner' && !(currentRole === 'admin' && member.role === 'admin');
            return (
              <Card key={member.user_id}>
                <View style={styles.row}>
                  <View style={styles.memberInfo}>
                    <ThemedText type="h3">{name}</ThemedText>
                    <ThemedText type="small">Добавлен {new Date(member.joined_at).toLocaleDateString('ru-RU')}</ThemedText>
                  </View>
                  <Badge tone={member.role === 'owner' ? 'primary' : 'neutral'}>{roleLabels[member.role]}</Badge>
                </View>
                {isEditing && canChangeRole ? (
                  <View style={[styles.roleEditor, { borderTopColor: theme.border }]}>
                    <Select label="Новая роль" value={editingRole} options={roleOptions} onChange={(role) => setEditingRole(role as ProjectRole)} accessibilityLabel={`Роль участника ${name}`} disabled={Boolean(busy)} />
                    <ThemedText type="small">{roleDescriptions[editingRole]}</ThemedText>
                    <ErrorMessage message={actionError} type="validation" />
                    <View style={styles.actions}>
                      <Button
                        size="sm"
                        loading={busy === `role:${member.user_id}`}
                        disabled={Boolean(busy) || editingRole === member.role}
                        onPress={() => void run(`role:${member.user_id}`, async () => {
                          await changeMemberRole(id!, member.user_id, editingRole);
                          setEditingMember(null);
                        }, `Роль участника «${name}» изменена.`)}
                      >Сохранить роль</Button>
                      <Button size="sm" variant="ghost" disabled={Boolean(busy)} onPress={() => { setEditingMember(null); setActionError(''); }}>Отмена</Button>
                    </View>
                  </View>
                ) : canManage && member.role !== 'owner' ? (
                  <View style={styles.actions}>
                    {canChangeRole ? <Button size="sm" variant="outline" disabled={Boolean(busy)} onPress={() => { setEditingMember(member.user_id); setEditingRole(member.role); setActionError(''); setShowAdd(false); }}>Изменить роль</Button> : null}
                    <Button size="sm" variant="ghost" disabled={Boolean(busy)} onPress={() => { setActionError(''); setRemove(member); }}>Удалить из проекта</Button>
                  </View>
                ) : null}
              </Card>
            );
          })}
          </View>
        </>
      )}
      {members.length ? (
        <View style={styles.roleHelp}>
          <Button variant="ghost" accessibilityState={{ expanded: showRoles }} onPress={() => setShowRoles((value) => !value)}>
            {showRoles ? 'Скрыть описание ролей ↑' : 'Какие права дают роли? ↓'}
          </Button>
          {showRoles ? <Card style={styles.form}>{(Object.keys(roleLabels) as ProjectRole[]).map((role) => (
            <View key={role} style={styles.roleCopy}><ThemedText type="h3">{roleLabels[role]}</ThemedText><ThemedText type="small">{roleDescriptions[role]}</ThemedText></View>
          ))}</Card> : null}
        </View>
      ) : null}
      <ConfirmDialog
        visible={Boolean(remove)}
        title="Удалить участника?"
        description={`«${remove?.profile?.display_name || 'Пользователь'}» потеряет доступ к проекту. При необходимости его можно добавить снова.`}
        confirmLabel="Удалить из проекта"
        busy={Boolean(busy)}
        onCancel={() => setRemove(null)}
        onConfirm={() => {
          const member = remove;
          if (!member) return;
          void run(`remove:${member.user_id}`, async () => {
            await removeProjectMember(id!, member.user_id);
            setRemove(null);
          }, 'Участник удалён из проекта.');
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.xl },
  list: { gap: spacing.md },
  sectionHeader: { gap: spacing.xs, marginBottom: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'flex-start', flexWrap: 'wrap', gap: spacing.md },
  memberInfo: { flex: 1, minWidth: 0, gap: spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  feedback: { gap: spacing.sm },
  form: { gap: spacing.lg },
  roleEditor: { gap: spacing.md, borderTopWidth: 1, paddingTop: spacing.lg, marginTop: spacing.xs },
  roleHelp: { gap: spacing.sm },
  roleCopy: { gap: spacing.xs },
});
