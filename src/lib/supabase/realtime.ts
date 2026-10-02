import { supabase } from '@/lib/supabase/client';
import { subscribeConnectivity, usesLocalReads } from '@/lib/connectivity/state';

export type RealtimeStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';
export type RealtimeEvent = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  new: Record<string, never>;
  old: Record<string, never>;
};

type SubscriptionOptions = {
  projectId?: string;
  taskId?: string;
  userId?: string;
  onEvent: (event: RealtimeEvent) => void;
  onStatus?: (status: RealtimeStatus, message?: string) => void;
};

type Listener = {
  table: string;
  onEvent: SubscriptionOptions['onEvent'];
  onStatus?: SubscriptionOptions['onStatus'];
};

type SharedChannel = {
  channel: ReturnType<typeof supabase.channel>;
  listeners: Set<Listener>;
  status: RealtimeStatus;
  message?: string;
};

const sharedChannels = new Map<string, SharedChannel>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function scopeTopic(options: SubscriptionOptions): string | null {
  const scopes = [
    options.projectId ? `project:${options.projectId}` : null,
    options.taskId ? `task:${options.taskId}` : null,
    options.userId ? `user:${options.userId}` : null,
  ].filter((value): value is string => Boolean(value));
  if (scopes.length !== 1) return null;
  const id = scopes[0].slice(scopes[0].indexOf(':') + 1);
  return UUID_PATTERN.test(id) ? scopes[0] : null;
}

function asRealtimeEvent(payload: unknown): RealtimeEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const envelope = payload as { payload?: unknown };
  if (!envelope.payload || typeof envelope.payload !== 'object') return null;
  const value = envelope.payload as { table?: unknown; operation?: unknown };
  if (typeof value.table !== 'string') return null;
  if (value.operation !== 'INSERT' && value.operation !== 'UPDATE' && value.operation !== 'DELETE') return null;
  return { eventType: value.operation, table: value.table, new: {}, old: {} };
}

function broadcastStatus(entry: SharedChannel, status: RealtimeStatus, message?: string) {
  entry.status = status;
  entry.message = message;
  for (const listener of entry.listeners) listener.onStatus?.(status, message);
}

function createSharedChannel(topic: string): SharedChannel {
  const entry: SharedChannel = {
    channel: supabase.channel(topic, { config: { private: true } }),
    listeners: new Set(),
    status: 'connecting',
  };
  sharedChannels.set(topic, entry);
  entry.channel
    .on('broadcast', { event: 'invalidate' }, (payload) => {
      const event = asRealtimeEvent(payload);
      if (!event) return;
      for (const listener of entry.listeners) {
        if (listener.table === event.table) listener.onEvent(event);
      }
    })
    .subscribe((status, error) => {
      if (!sharedChannels.has(topic)) return;
      if (status === 'SUBSCRIBED') broadcastStatus(entry, 'connected');
      else if (status === 'CHANNEL_ERROR') broadcastStatus(entry, 'error', error?.message);
      else if (status === 'TIMED_OUT') broadcastStatus(entry, 'reconnecting');
      else if (status === 'CLOSED') broadcastStatus(entry, 'disconnected');
    });
  return entry;
}

function subscribeOnlineTable(table: string, options: SubscriptionOptions) {
  const topic = scopeTopic(options);
  if (!topic) {
    options.onStatus?.('error', 'Exactly one valid realtime scope is required');
    return () => undefined;
  }

  const entry = sharedChannels.get(topic) ?? createSharedChannel(topic);
  const listener: Listener = { table, onEvent: options.onEvent, onStatus: options.onStatus };
  entry.listeners.add(listener);
  options.onStatus?.(entry.status, entry.message);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0) return;
    sharedChannels.delete(topic);
    void supabase.removeChannel(entry.channel);
  };
}

export function subscribeTable(table: string, options: SubscriptionOptions) {
  if (!scopeTopic(options)) {
    options.onStatus?.('error', 'Exactly one valid realtime scope is required');
    return () => undefined;
  }
  let cleanup: () => void = () => undefined;
  const connect = () => {
    cleanup(); cleanup = () => undefined;
    if (usesLocalReads()) options.onStatus?.('disconnected');
    else cleanup = subscribeOnlineTable(table, options);
  };
  const unsubscribe = subscribeConnectivity(connect);
  connect();
  return () => { unsubscribe(); cleanup(); };
}

export function subscribeMany(specs: { table: string; options: SubscriptionOptions }[]) {
  const cleanups = specs.map((spec) => subscribeTable(spec.table, spec.options));
  return () => cleanups.forEach((cleanup) => cleanup());
}

/**
 * Permission broadcasts carry no authorization data. They invalidate local
 * state, close resource topics immediately, and force all resulting data to be
 * fetched again through RLS-protected queries.
 */
export function subscribeToPermissionChanges(
  userId: string,
  onChange: () => void,
  onStatus?: (status: RealtimeStatus, message?: string) => void,
) {
  const invalidate = () => {
    closeResourceRealtimeChannels();
    onChange();
  };
  return subscribeMany([
    { table: 'projects', options: { userId, onEvent: invalidate, onStatus } },
    { table: 'tasks', options: { userId, onEvent: invalidate, onStatus } },
    { table: 'project_members', options: { userId, onEvent: invalidate, onStatus } },
    { table: 'task_members', options: { userId, onEvent: invalidate, onStatus } },
    { table: 'task_assignees', options: { userId, onEvent: invalidate, onStatus } },
  ]);
}

export function closeResourceRealtimeChannels() {
  for (const [topic, entry] of [...sharedChannels]) {
    if (topic.startsWith('user:')) continue;
    sharedChannels.delete(topic);
    entry.listeners.clear();
    void supabase.removeChannel(entry.channel);
  }
}

export function closeAllRealtimeChannels() {
  for (const [topic, entry] of [...sharedChannels]) {
    sharedChannels.delete(topic);
    entry.listeners.clear();
    void supabase.removeChannel(entry.channel);
  }
}
