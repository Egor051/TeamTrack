import { supabase } from '@/lib/supabase/client';

export type RealtimeStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';
export type RealtimeEvent = { eventType: 'INSERT' | 'UPDATE' | 'DELETE'; new: Record<string, unknown>; old: Record<string, unknown> };
type SubscriptionOptions = { projectId?: string; taskId?: string; userId?: string; onEvent: (event: RealtimeEvent) => void; onStatus?: (status: RealtimeStatus, message?: string) => void };
type ActiveChannel = {
  channel: ReturnType<typeof supabase.channel>;
  cleanup: () => void;
};

const activeChannels = new Set<ActiveChannel>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asRealtimeEvent(payload: unknown): RealtimeEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as { eventType?: unknown; new?: unknown; old?: unknown };
  if (value.eventType !== 'INSERT' && value.eventType !== 'UPDATE' && value.eventType !== 'DELETE') return null;
  const record = (candidate: unknown): Record<string, unknown> => candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
  return { eventType: value.eventType, new: record(value.new), old: record(value.old) };
}

export function subscribeTable(table: string, options: SubscriptionOptions) {
  const scope = options.userId ?? options.taskId ?? options.projectId;
  if (scope && !UUID_PATTERN.test(scope)) {
    options.onStatus?.('error', 'Invalid realtime scope');
    return () => undefined;
  }
  let active = true;
  const filter = options.userId ? `user_id=eq.${options.userId}` : options.taskId ? `task_id=eq.${options.taskId}` : options.projectId ? `project_id=eq.${options.projectId}` : undefined;
  const channel = supabase.channel(`tasktrace:${table}:${options.userId || options.projectId || ''}:${options.taskId || ''}`);
  const cleanup = () => {
    if (!active) return;
    active = false;
    activeChannels.delete(entry);
    void supabase.removeChannel(channel);
  };
  const entry: ActiveChannel = { channel, cleanup };
  activeChannels.add(entry);
  options.onStatus?.('connecting');
  const handlePayload = (payload: unknown) => {
    const event = asRealtimeEvent(payload);
    if (active && event) options.onEvent(event);
  };
  const change = { schema: 'public' as const, table, ...(filter ? { filter } : {}) };
  channel.on('postgres_changes', { ...change, event: 'INSERT' }, handlePayload);
  channel.on('postgres_changes', { ...change, event: 'UPDATE' }, handlePayload);
  channel.on('postgres_changes', { ...change, event: 'DELETE' }, handlePayload);
  channel.subscribe((status, err) => {
    if (!active) return;
    if (status === 'SUBSCRIBED') options.onStatus?.('connected');
    else if (status === 'CHANNEL_ERROR') options.onStatus?.('error', err?.message);
    else if (status === 'TIMED_OUT') options.onStatus?.('reconnecting');
    else if (status === 'CLOSED') options.onStatus?.('disconnected');
  });
  return cleanup;
}

export function subscribeMany(specs: { table: string; options: SubscriptionOptions }[]) {
  const cleanups = specs.map((spec) => subscribeTable(spec.table, spec.options));
  return () => cleanups.forEach((cleanup) => cleanup());
}

export function closeAllRealtimeChannels() {
  for (const entry of [...activeChannels]) entry.cleanup();
}
