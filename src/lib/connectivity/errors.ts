import { ResourceAccessDeniedError } from '@/lib/errors/domain-errors';
const transportCodes = new Set(['ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT',
  'ERR_NETWORK', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

export class ConnectivityUnavailableError extends Error {
  constructor() { super('Network unavailable: Failed to fetch. Данные не сохранены для работы офлайн.'); }
}

export function isExplicitAccessError(error: unknown): boolean {
  if (error instanceof ResourceAccessDeniedError) return true;
  const value = error as { status?: number; code?: string; message?: string } | null;
  const message = value?.message?.toLowerCase() ?? '';
  return value?.status === 401 || value?.status === 403 || value?.code === '42501' || value?.code === 'PGRST301'
    || /invalid jwt|jwt expired|session expired|auth session missing|access denied|permission denied|not authorized|unauthorized|forbidden/.test(message);
}

export function isTransportFailure(error: unknown): boolean {
  if (isExplicitAccessError(error)) return false;
  const value = error as { status?: number; code?: string; message?: string; name?: string } | null;
  if ((!value?.status || value.status === 0) && value?.code && transportCodes.has(value.code)) return true;
  // SQL/business errors remain authoritative even if a custom RPC chose a
  // gateway-like HTTP status. PostgREST connection errors use PGRST codes.
  if (typeof value?.code === 'string' && /^[A-Z0-9]{5}$/.test(value.code)) return false;
  if (value?.status === 502 || value?.status === 503 || value?.status === 504) return true;
  if (typeof value?.code === 'string' && value.code && value.code !== 'PGRST000') return false;
  if (value?.status && value.status !== 0) return false;
  const message = value?.message?.toLowerCase() ?? '';
  return value?.name === 'TimeoutError'
    || /failed to fetch|fetch failed|network request failed|networkerror|network error|err_network|load failed|timed? out|timeout|connection reset|econnreset|enotfound|dns/.test(message);
}
