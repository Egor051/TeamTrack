import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ThemedText } from '@/components/ui/text';
import { Badge } from '@/components/ui/badge';
import { ErrorMessage } from '@/components/ui/error-message';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { spacing } from '@/components/ui/theme';
import { roleLabels, taskRoleDescriptions } from './role-descriptions';
import { addTaskMemberByIdentifier, removeTaskMember, setTaskMemberOverride, clearTaskMemberOverride,
  addTaskAssignee, removeTaskAssignee, type TaskParticipant, type TaskChecklistRole, type ProjectRole } from './projects';

const roleOptions = (['admin', 'member', 'viewer'] as const).map((value) => ({ value, label: roleLabels[value] }));
export function TaskMembersPanel({ taskId, userId, projectRole, participants, assignees, busy, error, run }: {
  taskId: string; userId: string; projectRole: ProjectRole | null; participants: TaskParticipant[];
  assignees: string[]; busy: boolean; error?: string;
  run: (action: () => Promise<unknown>, target?: string) => Promise<boolean>;
}) {
  const [identifier, setIdentifier] = useState('');
  const [role, setRole] = useState<TaskChecklistRole>('member');
  const [confirmation, setConfirmation] = useState<{ title: string; description: string; label: string; action: () => Promise<unknown> } | null>(null);
  return <>
    <Card>
      <ThemedText type="h2">Роли и полномочия</ThemedText>
      <ThemedText type="small">Проектная роль даёт доступ ко всем этапам. Отдельная роль ниже действует только на чек-лист этого этапа и имеет приоритет над унаследованной. Участие только в этапе не даёт доступа к проекту и другим этапам.</ThemedText>
      <View style={styles.copy}><ThemedText type="h3">Владелец проекта</ThemedText><ThemedText type="small">Управляет самим этапом, его доступами и исполнителями; назначает роли чек-листа другим пользователям, включая проектных администраторов. Полномочия владельца наследуются из проекта. Передача владения выполняется в проекте.</ThemedText></View>
      {roleOptions.map(({ value, label }) => <View key={value} style={styles.copy}><ThemedText type="h3">{label}</ThemedText><ThemedText type="small">{taskRoleDescriptions[value]}</ThemedText></View>)}
      <ThemedText type="small">Управлять доступом и исполнителями могут владелец и администратор проекта. Администратор не меняет права проектного владельца и других проектных администраторов. Свою роль менять нельзя. В архиве доступен только просмотр.</ThemedText>
    </Card>
    <Card>
      <ThemedText type="h2">Добавить в этот этап</ThemedText>
      <ThemedText type="small">Email или ник аккаунта TaskTrace. Членство и роль в проекте останутся прежними.</ThemedText>
      <Input label="Email или ник" value={identifier} onChangeText={setIdentifier} autoCapitalize="none" autoCorrect={false} disabled={busy} />
      <Select label="Роль чек-листа" accessibilityLabel="Роль нового участника этапа" value={role} options={roleOptions} disabled={busy} onChange={(value) => setRole(value as TaskChecklistRole)} />
      <ThemedText type="small">{taskRoleDescriptions[role]}</ThemedText>
      <Button disabled={busy || !identifier.trim()} onPress={() => void (async () => {
        if (await run(() => addTaskMemberByIdentifier(taskId, identifier, role), 'members')) setIdentifier('');
      })()}>Добавить в этап</Button>
    </Card>
    <ErrorMessage message={error} type="validation" />
    <Card>
      <ThemedText type="h2">Исполнители</ThemedText>
      <ThemedText type="small">Назначение обозначает ответственность. Оно не меняет роль или доступ.</ThemedText>
      {participants.map((person) => {
        const assigned = assignees.includes(person.user_id);
        return <View key={person.user_id} style={styles.row}><ThemedText style={styles.name}>{person.display_name}</ThemedText>
          {assigned ? <Badge tone="primary">Назначен</Badge> : null}
          <Button size="sm" variant="outline" disabled={busy} onPress={() => setConfirmation({ title: assigned ? 'Снять назначение?' : 'Назначить исполнителя?',
            description: assigned ? 'Участие и роль пользователя сохранятся.' : 'Пользователь появится в списке исполнителей этого этапа.', label: assigned ? 'Снять' : 'Назначить',
            action: () => assigned ? removeTaskAssignee(taskId, person.user_id) : addTaskAssignee(taskId, person.user_id) })}>{assigned ? 'Снять' : 'Назначить'}</Button>
        </View>;
      })}
    </Card>
    <Card>
      <ThemedText type="h2">Доступ к этапу</ThemedText>
      <ThemedText type="small">Удаление прямого участия сохраняет доступ по проектной роли. Чтобы вернуть унаследованную роль чек-листа, выберите «Наследовать».</ThemedText>
      {participants.map((person) => {
        const canChange = person.user_id !== userId && (projectRole === 'owner' || !['owner', 'admin'].includes(person.project_role ?? ''));
        const options = [...(person.project_role ? [{ value: 'inherit', label: `Наследовать: ${roleLabels[person.project_role]}` }] : []), ...roleOptions];
        return <View key={person.user_id} style={styles.person}>
          <ThemedText type="h3">{person.display_name}{person.user_id === userId ? ' · Вы' : ''}</ThemedText>
          <ThemedText type="caption">{person.project_role ? `Проект: ${roleLabels[person.project_role]}` : 'Только этот этап'}{person.is_direct ? ' · Прямое участие' : ' · Доступ по проекту'}</ThemedText>
          <Select label="Полномочия чек-листа" accessibilityLabel={`Роль чек-листа для ${person.display_name}`} value={person.direct_role ?? 'inherit'} options={options} disabled={busy || !canChange}
            onChange={(value) => void run(() => value === 'inherit' ? clearTaskMemberOverride(taskId, person.user_id) : setTaskMemberOverride(taskId, person.user_id, value as TaskChecklistRole), 'members')} />
          {person.is_direct && canChange ? <Button size="sm" variant="ghost" disabled={busy} onPress={() => setConfirmation({ title: 'Удалить прямое участие?',
            description: person.project_role ? 'Участник останется в проекте. Доступ и роль чек-листа снова будут наследоваться от проекта.' : 'Пользователь потеряет доступ только к этому этапу. Назначение исполнителем будет снято.',
            label: 'Удалить из этапа', action: () => removeTaskMember(taskId, person.user_id) })}>Удалить из этапа</Button> : null}
        </View>;
      })}
    </Card>
    <ConfirmDialog visible={!!confirmation} title={confirmation?.title ?? ''} description={confirmation?.description ?? ''} confirmLabel={confirmation?.label ?? ''} error={error}
      busy={busy} destructive={confirmation?.label === 'Удалить из этапа'} onCancel={() => setConfirmation(null)} onConfirm={() => void (async () => {
        if (confirmation && await run(confirmation.action, 'members')) setConfirmation(null);
      })()} />
  </>;
}
const styles = StyleSheet.create({ copy: { gap: spacing.xs }, row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  name: { flexGrow: 1, flexShrink: 1, flexBasis: 160 }, person: { gap: spacing.sm, paddingVertical: spacing.sm } });
