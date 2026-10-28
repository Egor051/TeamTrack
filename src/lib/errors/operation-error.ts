import { ResourceAccessDeniedError } from './domain-errors';
import { isExplicitAccessError, isTransportFailure } from '@/lib/connectivity/errors';

import { errorKinds, operationStages, errorCodes, exceptionNames, type SafeException } from '../../../supabase/functions/_shared/client-error-schema';
export { errorKinds, operationStages };
export type ErrorKind = typeof errorKinds[number];
export type OperationStage = typeof operationStages[number];
export type ErrorContext = {
  stage?: OperationStage;
  operation?: 'set_task_item_state' | 'set_task_item_percentage' | 'set_task_item_comment' | 'sync' | 'mutation' | 'unknown';
  userId?: string;
  taskId?: string;
  itemId?: string;
  displayedVersion?: number;
  serverVersion?: number;
  snapshotAtFailure?: 'missing' | 'invalid';
  capabilities?: { write: boolean; sync: boolean; available: boolean };
};

const messages: Record<ErrorKind, string> = {
  local_data: 'Для изменения пункта сначала синхронизируйте данные при подключении к интернету. Подтверждённая версия на устройстве отсутствует или повреждена; сохранённая очередь останется на месте.',
  outbox_blocked: 'Сначала разрешите несинхронизированные изменения пункта через индикатор синхронизации. Они сохранены на устройстве.',
  conflict: 'Подтверждённая версия данных изменилась. Обновите данные и проверьте свой черновик перед сохранением.',
  permission: 'Доступ запрещён. У вашей роли нет прав на это действие.',
  server: 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.',
  session: 'Требуется авторизация: не удалось подтвердить сеанс. Подключитесь к интернету и обновите данные; при необходимости войдите снова. Не очищайте сохранённые изменения.',
  storage: 'Не удалось сохранить изменение в хранилище устройства. Повторите попытку; сохранённую очередь очищать не нужно.',
  storage_full: 'На устройстве недостаточно места для сохранения изменения. Освободите место и повторите попытку. Не удаляйте данные TaskTrace с несинхронизированными изменениями.',
  write_disabled: 'Новые локальные изменения временно отключены. Подключитесь к интернету и проверьте состояние синхронизации. Сохранённые изменения остаются на устройстве.',
  unknown: 'Операция не выполнена. Повторите попытку после обновления данных.',
};

export class OperationError extends Error {
  constructor(public readonly kind: ErrorKind, public readonly code: string, stage: OperationStage, options?: { cause?: unknown; message?: string }) {
    super(options?.message ?? messages[kind], options);
    this.name = 'OperationError';
    annotateError(this, { stage, ...(code === 'TT_LOCAL_SNAPSHOT_MISSING' ? { snapshotAtFailure: 'missing' as const }
      : code === 'TT_LOCAL_SNAPSHOT_INVALID' ? { snapshotAtFailure: 'invalid' as const } : {}) });
  }
}

const contexts = new WeakMap<object, ErrorContext>();
/** Attach context without changing SQL codes, exception identity or its cause. */
export function annotateError(error: unknown, context: ErrorContext): unknown {
  if (error && typeof error === 'object') {
    const previous = contexts.get(error) ?? {};
    contexts.set(error, { ...context, ...previous }); // The innermost stage wins.
  }
  return error;
}
export function errorContext(error: unknown): ErrorContext {
  return error && typeof error === 'object' ? contexts.get(error) ?? {} : {};
}

export function classifyError(error: unknown): ErrorKind {
  if (error instanceof OperationError) return error.kind;
  const e = error as { name?: string; code?: string; message?: string; status?: number } | null;
  if (e?.name === 'QuotaExceededError' || e?.code === 'SQLITE_FULL') return 'storage_full';
  if (e?.code === 'LOCAL_STORAGE') return 'storage';
  if (errorContext(error).stage?.startsWith('storage_') || ['cache_read', 'cache_write'].includes(errorContext(error).stage ?? '')) return 'storage';
  if (['VersionError', 'InvalidStateError', 'NotReadableError', 'UnknownError', 'DataError', 'TransactionInactiveError'].includes(e?.name ?? '')) return 'storage';
  if (e?.code === 'PT409') return 'conflict';
  if (e?.status === 401 || ['PGRST301', 'PGRST303', '28000', '28P01', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used'].includes(e?.code ?? '')
    || ['AuthSessionMissingError', 'AuthSessionUnavailableError'].includes(e?.name ?? '')
    || (typeof e?.message === 'string' && /jwt expired|invalid jwt|session expired|auth session missing/i.test(e.message))) return 'session';
  if (error instanceof ResourceAccessDeniedError || isExplicitAccessError(error)) return 'permission';
  if (isTransportFailure(error)) return 'server';
  return 'unknown';
}

export const operationErrorMessage = (kind: ErrorKind): string => messages[kind];

export function safeException(error: unknown): SafeException {
  const e = error as { name?: unknown; code?: unknown } | null;
  return {
    name: exceptionNames.includes(e?.name as SafeException['name']) ? e!.name as SafeException['name'] : 'UnknownException',
    code: e?.code === undefined ? 'NONE' : errorCodes.includes(e.code as SafeException['code']) ? e.code as SafeException['code'] : 'OTHER',
  };
}
export function safeConsoleError(error: unknown): Error {
  const safe = safeException(error);
  const summary = Object.assign(new Error(operationErrorMessage(classifyError(error))), safe, { stage: errorContext(error).stage ?? 'ui' });
  summary.stack = undefined;
  return summary;
}

export function storageError(error: unknown, stage: OperationStage): unknown {
  if (error instanceof OperationError) return error;
  if (error && typeof error === 'object') return annotateError(error, { stage });
  return new OperationError('storage', 'TT_STORAGE', stage, { cause: error });
}
