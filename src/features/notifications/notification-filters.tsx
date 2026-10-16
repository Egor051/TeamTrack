import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { DeadlinePicker } from '@/components/ui/deadline-picker';
import { formatDeadline } from '@/features/projects/deadlines';
import { notificationActions, type NotificationFilters as Filters } from './notification-state';
import type { NotificationFilterOptions } from './notifications';

export function NotificationFilters({ value, onChange, options }: { value: Filters; onChange: (next: Filters) => void; options: NotificationFilterOptions }) {
  const [dateField, setDateField] = useState<'from' | 'to' | null>(null);
  return <Card>
    <View style={styles.row}>
      <View style={styles.field}><Select label="Проект" accessibilityLabel="Фильтр по проекту" value={value.projectId ?? ''}
        options={[{ value: '', label: 'Все проекты' }, ...options.projects.map((p) => ({ value: p.id, label: p.name }))]}
        onChange={(projectId) => onChange({ ...value, projectId, taskId: '' })} /></View>
      <View style={styles.field}><Select label="Этап" accessibilityLabel="Фильтр по этапу" value={value.taskId ?? ''}
        options={[{ value: '', label: 'Все этапы' }, ...options.tasks.filter((t) => !value.projectId || t.project_id === value.projectId).map((t) => ({ value: t.id, label: t.title }))]}
        onChange={(taskId) => onChange({ ...value, taskId })} /></View>
      <View style={styles.field}><Select label="Действие" accessibilityLabel="Фильтр по действию" value={value.action ?? ''}
        options={[{ value: '', label: 'Все действия' }, ...notificationActions]} onChange={(action) => onChange({ ...value, action })} /></View>
      <View style={styles.field}><Select label="Прочтение" accessibilityLabel="Фильтр по прочтению" value={value.read ?? 'all'}
        options={[{ value: 'all', label: 'Все уведомления' }, { value: 'unread', label: 'Непрочитанные' }, { value: 'read', label: 'Прочитанные' }]}
        onChange={(read) => onChange({ ...value, read: read as Filters['read'] })} /></View>
    </View>
    <View style={styles.row}>
      <Button size="sm" variant="outline" onPress={() => setDateField('from')}>С: {value.from ? formatDeadline(value.from) : 'начала'}</Button>
      <Button size="sm" variant="outline" onPress={() => setDateField('to')}>По: {value.to ? formatDeadline(value.to) : 'настоящее время'}</Button>
      <Button size="sm" variant="ghost" onPress={() => onChange({})}>Сбросить фильтры</Button>
    </View>
    {dateField ? <DeadlinePicker key={dateField} value={value[dateField] ?? null} busy={false} futureOnly={false} title={dateField === 'from' ? 'Начало периода' : 'Конец периода'}
      onCancel={() => setDateField(null)} onSave={async (iso) => { onChange({ ...value, [dateField]: iso }); setDateField(null); }} /> : null}
  </Card>;
}
const styles = StyleSheet.create({ row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }, field: { flexBasis: 210, flexGrow: 1, minWidth: 0 } });
