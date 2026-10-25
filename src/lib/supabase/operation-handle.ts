import type { Json } from '@/types/database.types';

export type OperationContext = {
  protocol_version: 3; fingerprint_version: 1; generation: string; epoch: number;
  admit_until: string; replay_until: string;
};
export type OperationHandle = OperationContext & { id: string };
export type OperationResolution = {
  state: 'completed' | 'unknown' | 'not_applied' | 'expired' | 'history_reset' | 'result_redacted' | 'invalid_epoch' | 'window_closing' | 'never_sent';
  terminal?: boolean;
  result?: { format_version?: number; value: Json; http_status?: number; retry_after_until?: string | null };
};
export function operationContext(value: unknown): OperationContext {
  const v = value as OperationContext | null;
  if (!v || v.protocol_version !== 3 || v.fingerprint_version !== 1
    || typeof v.generation !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v.generation)
    || !Number.isSafeInteger(v.epoch) || v.epoch < 1
    || !Number.isFinite(Date.parse(v.admit_until)) || !Number.isFinite(Date.parse(v.replay_until))
    || Date.parse(v.replay_until) <= Date.parse(v.admit_until)) {
    throw Object.assign(new Error('Сервер вернул неподдерживаемый контекст операции.'), { code: 'TT_OPERATION_CONTEXT' });
  }
  return v;
}
export function operationReview(error: { code?: string; details?: string } | null | undefined): string | null {
  const aliases: Record<string, string> = { TT_HISTORY_RESET: 'TT_OPERATION_HISTORY_RESET', TT_RESULT_REDACTED: 'TT_OPERATION_RESULT_REDACTED' };
  const raw = error?.details?.startsWith('TT_OPERATION_') || aliases[error?.details ?? ''] ? error?.details : error?.code;
  const code = aliases[raw ?? ''] ?? raw;
  return ['TT_OPERATION_EXPIRED', 'TT_OPERATION_HISTORY_RESET', 'TT_OPERATION_RESULT_REDACTED', 'TT_OPERATION_INVALID_EPOCH', 'TT_OPERATION_NAMESPACE'].includes(code ?? '') ? code! : null;
}
export function reviewError(reason: string) {
  return Object.assign(new Error(reason === 'TT_OPERATION_RESULT_REDACTED'
    ? 'Действие завершено, но прежний результат недоступен. Получите актуальное состояние.'
    : 'Результат действия не удалось подтвердить. Получите актуальное состояние и согласуйте сохранённый черновик.'), { code: reason });
}
