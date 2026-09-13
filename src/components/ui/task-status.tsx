import { Badge } from './badge';

export const taskStatusLabels = { not_started: 'Не начата', in_progress: 'В работе', completed: 'Завершена', archived: 'В архиве' } as const;
export function TaskStatus({ status }: { status: keyof typeof taskStatusLabels }) {
  return <Badge accessibilityLabel={`Статус: ${taskStatusLabels[status]}`} tone={status === 'completed' ? 'success' : status === 'in_progress' ? 'primary' : 'neutral'}>{taskStatusLabels[status]}</Badge>;
}
