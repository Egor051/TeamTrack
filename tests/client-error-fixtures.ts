import { createErrorEvent } from '@/lib/diagnostics/event';
import { OperationError } from '@/lib/errors/operation-error';
import type { ClientErrorEvent } from '../supabase/functions/_shared/client-error-schema';

export function diagnosticEvent(overrides: Partial<ClientErrorEvent> = {}, now = Date.now()): ClientErrorEvent {
  return { ...createErrorEvent(new OperationError('local_data', 'TT_LOCAL_SNAPSHOT_MISSING', 'enqueue'),
    { operation: 'set_task_item_state', displayedVersion: 1 }, {
      connection: 'degraded', network_issue: 'data-service', capabilities: { write: true, sync: true, available: true },
      cache: { snapshot: 'missing', version: null }, outbox: { pending: 0, failed: 0, conflict: 0, review: 0, acknowledged: 0, dependent: false }, sw_version: null,
    }, now), ...overrides };
}
