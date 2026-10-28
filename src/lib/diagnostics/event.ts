import app from '../../../app.json';
import { classifyError, errorContext, safeException, type ErrorContext } from '@/lib/errors/operation-error';
import { frameModules, validClientErrorEvent, type ClientErrorEvent, type SafeException } from '../../../supabase/functions/_shared/client-error-schema';
import { newOperationId } from '@/lib/local-cache/uuid';

export type DiagnosticState = Pick<ClientErrorEvent, 'connection' | 'capabilities' | 'cache' | 'outbox' | 'sw_version' | 'network_issue'>;
const integerVersion = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
function frames(error: unknown): ClientErrorEvent['error']['frames'] {
  const stack = (error as { stack?: unknown } | null)?.stack;
  if (typeof stack !== 'string') return [];
  const result: ClientErrorEvent['error']['frames'] = [];
  // Extract coordinates of known source modules only. No message, function name,
  // URL, query string, device path or arbitrary stack text crosses the boundary.
  for (const line of stack.slice(0, 8000).split('\n').slice(1, 20)) {
    const m = /(?:\b(edit|outbox|sync|cache|repository|runtime-config|driver\.web|driver\.native|mutation|user-message)\.tsx?|\b(entry-[a-f\d]{32}\.js)|\b(index\.(?:android|ios)\.bundle)):(\d{1,8}):(\d{1,8})(?:\)|$)/i.exec(line);
    if (!m) continue;
    const module = m[1] ?? (m[2] ? 'web_bundle' : 'native_bundle');
    if (frameModules.includes(module as typeof frameModules[number])) result.push({ module: module as typeof frameModules[number], line: Number(m[4]), column: Number(m[5]) });
    if (result.length === 6) break;
  }
  return result;
}
export function applicationBuild(): string {
  const explicit = process.env.EXPO_PUBLIC_APP_BUILD_ID;
  if (explicit && /^[a-f\d]{7,64}$/.test(explicit)) return explicit;
  if (typeof document !== 'undefined') {
    for (const script of Array.from(document.scripts)) {
      const match = /\/entry-([a-f\d]{32})\.js(?:$|\?)/.exec(script.src);
      if (match) return match[1];
    }
  }
  return process.env.NODE_ENV === 'production' ? 'unknown' : 'development';
}
export function createErrorEvent(error: unknown, context: ErrorContext, state: DiagnosticState, now = Date.now()): ClientErrorEvent {
  const origin = { ...context, ...errorContext(error) };
  const causes: SafeException[] = [];
  const visited = new Set<unknown>([error]);
  let cause = (error as { cause?: unknown } | null)?.cause;
  while (cause && !visited.has(cause) && causes.length < 3) {
    visited.add(cause); causes.push(safeException(cause));
    cause = (cause as { cause?: unknown }).cause;
  }
  const event: ClientErrorEvent = {
    schema_version: 1, event_id: newOperationId(), occurred_at: new Date(now).toISOString(),
    app_version: app.expo.version, app_build: applicationBuild(), protocol_version: 3, sw_version: state.sw_version,
    kind: classifyError(error), operation: origin.operation ?? 'unknown', stage: origin.stage ?? 'ui',
    error: { ...safeException(error), causes, frames: frames(error) }, connection: state.connection, network_issue: state.network_issue,
    capabilities: origin.capabilities ? { write: origin.capabilities.write, sync: origin.capabilities.sync, available: origin.capabilities.available } : state.capabilities,
    // Recovery may finish before detached metadata reads. Keep the guard's
    // observed failure instead of reporting the newly repaired snapshot.
    cache: origin.snapshotAtFailure ? { snapshot: origin.snapshotAtFailure, version: null } : state.cache,
    outbox: state.outbox, displayed_version: integerVersion(origin.displayedVersion), server_version: integerVersion(origin.serverVersion),
  };
  if (!validClientErrorEvent(event)) throw new Error('Invalid diagnostic projection');
  return event;
}
/** Fingerprint contains only approved structural fields, never user input. */
export function eventFingerprint(e: ClientErrorEvent): string {
  const text = JSON.stringify([e.app_build, e.kind, e.operation, e.stage, e.error.name, e.error.code, e.error.causes, e.error.frames, e.cache?.snapshot, e.connection, e.network_issue, e.capabilities]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
