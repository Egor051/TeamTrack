import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MultiSelect } from '@/components/ui/select';
import { ErrorMessage } from '@/components/ui/error-message';
import { ThemedText } from '@/components/ui/text';
import { DeadlinePicker } from '@/components/ui/deadline-picker';
import { formatDeadline } from '@/features/projects/deadlines';
import { notificationActions, notificationFilterValues, type NotificationFilters as Filters } from './notification-state';
import type { NotificationFilterOptions } from './notifications';

export function NotificationFilters({ value, onApply, options }: { value: Filters; onApply: (next: Filters) => void; options: NotificationFilterOptions }) {
  const [draft, setDraft] = useState<Filters>(value);
  const [dateField, setDateField] = useState<'from' | 'to' | null>(null);
  const { projectIds, taskIds, actions, reads } = notificationFilterValues(draft);
  const periodError = draft.from && draft.to && Date.parse(draft.from) > Date.parse(draft.to) ? 'Начало периода должно быть раньше конца.' : '';
  return <Card>
    <View style={styles.row}>
      <View style={styles.field}><MultiSelect label="Проекты" accessibilityLabel="Фильтр по проекту" value={projectIds} placeholder="Все проекты"
        options={options.projects.map((p) => ({ value: p.id, label: p.name }))} onChange={(next) => setDraft({ ...draft, projectIds: next,
          taskIds: taskIds.filter((id) => !next.length || options.tasks.some((t) => t.id === id && next.includes(t.project_id))) })} /></View>
      <View style={styles.field}><MultiSelect label="Этапы" accessibilityLabel="Фильтр по этапу" value={taskIds} placeholder="Все этапы"
        options={options.tasks.filter((t) => !projectIds.length || projectIds.includes(t.project_id)).map((t) => ({ value: t.id, label: t.title }))}
        onChange={(next) => setDraft({ ...draft, taskIds: next })} /></View>
      <View style={styles.field}><MultiSelect label="Действия" accessibilityLabel="Фильтр по действию" value={actions} placeholder="Все действия"
        options={notificationActions} onChange={(next) => setDraft({ ...draft, actions: next })} /></View>
      <View style={styles.field}><MultiSelect label="Прочтение" accessibilityLabel="Фильтр по прочтению" value={reads} placeholder="Все уведомления"
        options={[{ value: 'unread', label: 'Непрочитанные' }, { value: 'read', label: 'Прочитанные' }]}
        onChange={(next) => setDraft({ ...draft, reads: next as ('read' | 'unread')[] })} /></View>
    </View>
    <View style={styles.row}>
      <Button size="sm" variant="outline" onPress={() => setDateField('from')}>С: {draft.from ? formatDeadline(draft.from) : 'начала'}</Button>
      <Button size="sm" variant="outline" onPress={() => setDateField('to')}>По: {draft.to ? formatDeadline(draft.to) : 'настоящее время'}</Button>
      <Button size="sm" variant="ghost" onPress={() => setDraft({})}>Сбросить фильтры</Button>
      <Button size="sm" disabled={!!periodError} onPress={() => onApply({ ...draft, projectIds: [...projectIds], taskIds: [...taskIds], actions: [...actions], reads: [...reads] })}>Применить</Button>
    </View>
    <ThemedText type="caption">Выбор и сброс вступят в силу после нажатия «Применить».</ThemedText>
    <ErrorMessage message={periodError} type="validation" />
    {dateField ? <DeadlinePicker key={dateField} value={draft[dateField] ?? null} busy={false} futureOnly={false} title={dateField === 'from' ? 'Начало периода' : 'Конец периода'}
      onCancel={() => setDateField(null)} onSave={async (iso) => { setDraft({ ...draft, [dateField]: iso }); setDateField(null); }} /> : null}
  </Card>;
}
const styles = StyleSheet.create({ row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }, field: { flexBasis: 210, flexGrow: 1, minWidth: 0 } });
