export function userMessage(error: unknown, fallback: string): string {
  if (process.env.NODE_ENV !== 'production') console.error('[TaskTrace]', error);
  const value = error as { message?: string; code?: string; status?: number } | null;
  const message = value?.message?.toLowerCase() ?? '';
  if (message.includes('user not found')) return 'Пользователь не найден.';
  if (message.includes('already a project member')) return 'Пользователь уже добавлен в проект.';
  if (message.includes('display name is ambiguous')) return 'Найдено несколько пользователей с таким ником. Укажите email.';
  if (message.includes('identifier is required')) return 'Укажите email или ник пользователя.';
  if (value?.status === 401 || value?.status === 403 || message.includes('permission') || message.includes('not authorized') || message.includes('access denied')) return 'Доступ запрещён. У вашей роли нет прав на это действие.';
  if (message.includes('network') || message.includes('fetch') || message.includes('timeout')) return 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.';
  if (message.includes('duplicate') || value?.code === '23505') return 'Такая запись уже существует.';
  if (message.includes('not found') || value?.code === 'PGRST116') return 'Запись не найдена или больше недоступна.';
  return fallback;
}
