// Dependency-free contract shared by the app and Edge ingress. No raw error,
// request, URL, user input, resource identifier or arbitrary string is accepted.
export const MAX_EVENT_BYTES = 4096;
export const errorKinds = ['local_data', 'outbox_blocked', 'conflict', 'permission', 'server', 'session', 'storage', 'storage_full', 'write_disabled', 'unknown'] as const;
export const operationStages = ['ui', 'identity', 'version', 'capabilities', 'outbox', 'enqueue', 'snapshot_recovery', 'storage_open', 'storage_read', 'storage_write', 'cache_read', 'cache_write', 'sync_auth', 'sync_context', 'sync_send', 'sync_ack', 'sync_reconcile', 'mutation', 'service_worker', 'unhandled'] as const;
export const operations = ['set_task_item_state', 'set_task_item_percentage', 'set_task_item_comment', 'sync', 'mutation', 'unknown'] as const;
export const exceptionNames = ['Error', 'OperationError', 'TypeError', 'RangeError', 'SyntaxError', 'DOMException', 'QuotaExceededError', 'VersionError', 'InvalidStateError', 'NotReadableError', 'UnknownError', 'DataError', 'TransactionInactiveError', 'ConstraintError', 'SecurityError', 'DataCloneError', 'ReadOnlyError', 'NotFoundError', 'NotSupportedError', 'NetworkError', 'AbortError', 'TimeoutError', 'AuthSessionMissingError', 'AuthSessionUnavailableError', 'ResourceAccessDeniedError', 'ServiceUnavailableError', 'MutationOutcomeUnknownError', 'SupersededReadError', 'UnknownException'] as const;
export const errorCodes = ['NONE', 'OTHER', '42501', 'PT409', 'PT426', 'PT429', 'PT503', '22023', '23505', '23514', '22P02', 'P0001', '28000', '28P01', 'PGRST000', 'PGRST116', 'PGRST202', 'PGRST301', 'PGRST303', 'SQLITE_FULL', 'TT_LOCAL_SNAPSHOT_MISSING', 'TT_LOCAL_SNAPSHOT_INVALID', 'TT_LOCAL_VERSION', 'TT_OUTBOX_BLOCKED', 'TT_SESSION', 'TT_CAPABILITIES', 'TT_WRITE_DISABLED', 'TT_STORAGE', 'TT_STORAGE_FULL', 'TT_OPERATION_CONTEXT', 'TT_OPERATION_EXPIRED', 'TT_OPERATION_HISTORY_RESET', 'TT_OPERATION_RESULT_REDACTED', 'TT_OPERATION_HANDLE_MISSING', 'TT_OPERATION_LEGACY_REVIEW', 'TT_OPERATION_NOT_APPLIED', 'TT_OPERATION_WINDOW_CLOSING', 'TT_MUTATION_RECONCILED', 'TT_MUTATION_PENDING', 'TT_MUTATION_STORAGE', 'LOCAL_STORAGE', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used'] as const;
export const frameModules = ['edit', 'outbox', 'sync', 'cache', 'repository', 'runtime-config', 'driver.web', 'driver.native', 'mutation', 'user-message', 'web_bundle', 'native_bundle'] as const;
export type SafeException = { name: typeof exceptionNames[number]; code: typeof errorCodes[number] };
export type ClientErrorEvent = {
  schema_version: 1;
  event_id: string;
  occurred_at: string;
  app_version: string;
  app_build: string;
  protocol_version: 3;
  sw_version: string | null;
  kind: typeof errorKinds[number];
  operation: typeof operations[number];
  stage: typeof operationStages[number];
  error: SafeException & { causes: SafeException[]; frames: { module: typeof frameModules[number]; line: number; column: number }[] };
  connection: 'online' | 'offline' | 'degraded';
  network_issue: 'network' | 'auth-service' | 'data-service' | 'authorization' | null;
  capabilities: { write: boolean; sync: boolean; available: boolean } | null;
  cache: { snapshot: 'valid' | 'missing' | 'invalid' | 'unavailable'; version: number | null } | null;
  outbox: { pending: number; failed: number; conflict: number; review: number; acknowledged: number; dependent: boolean } | null;
  displayed_version: number | null;
  server_version: number | null;
};
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const keys = (x: Record<string, unknown>, allowed: string[]) => Object.keys(x).length === allowed.length && Object.keys(x).every(k => allowed.includes(k));
const member = (x: unknown, allowed: readonly string[]) => typeof x === 'string' && allowed.includes(x);
const integer = (x: unknown, maximum = Number.MAX_SAFE_INTEGER) => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= maximum;
const version = (x: unknown) => x === null || (integer(x) && Number(x) >= 1);
const safeException = (x: unknown) => plain(x) && keys(x, ['name', 'code']) && member(x.name, exceptionNames) && member(x.code, errorCodes);
export function eventBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }

export function validClientErrorEvent(x: unknown): x is ClientErrorEvent {
  if (!plain(x) || !keys(x, ['schema_version', 'event_id', 'occurred_at', 'app_version', 'app_build', 'protocol_version', 'sw_version', 'kind', 'operation', 'stage', 'error', 'connection', 'network_issue', 'capabilities', 'cache', 'outbox', 'displayed_version', 'server_version'])) return false;
  if (x.schema_version !== 1 || x.protocol_version !== 3 || typeof x.event_id !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(x.event_id)) return false;
  if (typeof x.occurred_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x.occurred_at) || !Number.isFinite(Date.parse(x.occurred_at))) return false;
  if (typeof x.app_version !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(x.app_version) || typeof x.app_build !== 'string' || !/^(?:[a-f\d]{7,64}|unknown|development)$/.test(x.app_build)) return false;
  if (x.sw_version !== null && (typeof x.sw_version !== 'string' || !/^[a-f\d]{16,64}$/.test(x.sw_version))) return false;
  if (!member(x.kind, errorKinds) || !member(x.operation, operations) || !member(x.stage, operationStages) || !member(x.connection, ['online', 'offline', 'degraded']) || !version(x.displayed_version)) return false;
  if (x.network_issue !== null && !member(x.network_issue, ['network', 'auth-service', 'data-service', 'authorization'])) return false;
  if (!version(x.server_version)) return false;
  if (!plain(x.error) || !keys(x.error, ['name', 'code', 'causes', 'frames']) || !member(x.error.name, exceptionNames) || !member(x.error.code, errorCodes)
    || !Array.isArray(x.error.causes) || x.error.causes.length > 3 || !x.error.causes.every(safeException)
    || !Array.isArray(x.error.frames) || x.error.frames.length > 6 || !x.error.frames.every(f => plain(f) && keys(f, ['module', 'line', 'column']) && member(f.module, frameModules) && integer(f.line, 100000000) && integer(f.column, 100000000))) return false;
  if (x.capabilities !== null && (!plain(x.capabilities) || !keys(x.capabilities, ['write', 'sync', 'available']) || Object.values(x.capabilities).some(v => typeof v !== 'boolean'))) return false;
  if (x.cache !== null && (!plain(x.cache) || !keys(x.cache, ['snapshot', 'version']) || !member(x.cache.snapshot, ['valid', 'missing', 'invalid', 'unavailable']) || !version(x.cache.version))) return false;
  if (x.outbox !== null && (!plain(x.outbox) || !keys(x.outbox, ['pending', 'failed', 'conflict', 'review', 'acknowledged', 'dependent'])
    || !['pending', 'failed', 'conflict', 'review', 'acknowledged'].every(k => integer((x.outbox as Record<string, unknown>)[k], 100000)) || typeof x.outbox.dependent !== 'boolean')) return false;
  return eventBytes(x) <= MAX_EVENT_BYTES;
}
