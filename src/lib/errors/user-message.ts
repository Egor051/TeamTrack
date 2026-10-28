import { ResourceAccessDeniedError } from '@/lib/errors/domain-errors';
import { classifyError, operationErrorMessage, safeConsoleError } from './operation-error';
import { reportClientError } from './error-events';

export function userMessage(error: unknown, fallback: string): string {
  reportClientError(error);
  if (process.env.NODE_ENV !== 'production' && !(error instanceof ResourceAccessDeniedError)) console.error('[TaskTrace]', safeConsoleError(error));
  const value = error as { message?: string; code?: string; status?: number; details?: string } | null;
  const message = typeof value?.message === 'string' ? value.message.toLowerCase() : '';
  if (error instanceof ResourceAccessDeniedError) return error.message;
  const kind = classifyError(error);
  if (kind !== 'unknown') return operationErrorMessage(kind);
  if (typeof value?.code === 'string' && value.code.startsWith('TT_OPERATION_')) return 'Результат действия требует согласования. Получите актуальное состояние через индикатор синхронизации; ваш черновик сохранён.';
  if (value?.details === 'TT_RECEIPT_POLICY') return 'Сохранение временно недоступно: требуется настройка лимитов операций на сервере. Ваш черновик сохранён.';
  if (value?.details === 'TT_RECEIPT_LIMIT' || value?.details === 'TT_RECEIPT_RATE') return 'Достигнут лимит операций или их хранения. Изменение не выполнено; ваш черновик сохранён. Повторите позже или обратитесь к администратору.';
  if (value?.code === 'PT426') return 'Обновите приложение перед сохранением. Сохраните черновик, закройте старые вкладки и откройте приложение заново. Не очищайте несинхронизированную очередь.';
  if ((error as Error)?.name === 'MutationOutcomeUnknownError') return 'Ответ сервера не получен. Результат действия уточняется при повторе; повтор использует тот же идентификатор.';
  if (value?.code === 'TT_MUTATION_RECONCILED') return 'Предыдущее действие согласовано. Обновите данные и проверьте новое изменение перед сохранением.';
  if (value?.code === 'TT_MUTATION_PENDING') return 'Предыдущее действие ещё выполняется. Дождитесь результата и проверьте состояние синхронизации.';
  if (value?.code === 'TT_MUTATION_STORAGE') return operationErrorMessage('storage');
  if (value?.code === 'TT_MEMBER_LOOKUP') return 'Не удалось добавить участника по указанному идентификатору.';
  if (value?.code === 'PT429') return 'Слишком много попыток добавления участников. Повторите через минуту.';
  if (message === 'для этого действия требуется подключение к интернету.') return 'Для этого действия требуется подключение к интернету.';
  if (message.includes('user not found')) return 'Пользователь не найден.';
  if (message.includes('already a project member')) return 'Пользователь уже добавлен в проект.';
  if (message.includes('display name is ambiguous')) return 'Найдено несколько пользователей с таким ником. Укажите email.';
  if (message.includes('identifier is required')) return 'Укажите email или ник пользователя.';
  if (message.includes('duplicate') || value?.code === '23505') return 'Такая запись уже существует.';
  if (message.includes('not found') || value?.code === 'PGRST116') return 'Запись не найдена или больше недоступна.';
  return fallback;
}

export function mutationUserMessage(error: unknown, fallback: string): string {
  const message = userMessage(error, fallback);
  return process.env.EXPO_PUBLIC_OFFLINE_WRITE_ENABLED === 'true'
    && message === 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.'
    ? 'Для этого действия требуется подключение к интернету.'
    : message;
}
