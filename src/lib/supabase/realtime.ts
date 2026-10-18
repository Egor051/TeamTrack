import { supabase } from '@/lib/supabase/client';
import { subscribeConnectivity, usesLocalReads } from '@/lib/connectivity/state';
import { currentReadAccount, readAccountEpoch, invalidateRealtimeModels, invalidateReadModels } from '@/lib/local-cache/read-freshness';

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
  templates?: true;
  onEvent: (event: RealtimeEvent) => void;
  onStatus?: (status: RealtimeStatus, message?: string) => void;
};

type Listener = {
  table: string;
  onEvent: SubscriptionOptions['onEvent'];
  onStatus?: SubscriptionOptions['onStatus'];
};

type SharedChannel = {
  userId: string | null;
  accountEpoch: number;
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
    options.templates ? 'templates' : null,
  ].filter((value): value is string => Boolean(value));
  if (scopes.length !== 1) return null;
  if (scopes[0] === 'templates') return 'templates';
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

function createSharedChannel(topic: string, userId: string | null): SharedChannel {
  const entry: SharedChannel = {
    userId, accountEpoch: readAccountEpoch(),
    channel: supabase.channel(topic, { config: { private: true } }),
    listeners: new Set(),
    status: 'connecting',
  };
  sharedChannels.set(topic, entry);
  const current = () => sharedChannels.get(topic) === entry && entry.accountEpoch === readAccountEpoch()
    && (currentReadAccount() === entry.userId || currentReadAccount() === null);
  entry.channel
    .on('broadcast', { event: 'invalidate' }, (payload) => {
      if (!current()) return;
      const event = asRealtimeEvent(payload);
      if (!event) return;
      const userId = entry.userId;
      if (userId) {
        const [kind, id] = topic.split(':');
        void invalidateRealtimeModels(userId, event.table, { ...(kind === 'project' ? { projectId: id } : kind === 'task' ? { taskId: id } : { userId: id }) }, event.eventType)
          .catch((error) => console.warn('[TaskTrace] realtime invalidation failed', error));
      }
      for (const listener of entry.listeners) {
        if (listener.table === event.table) listener.onEvent(event);
      }
    })
    .subscribe((status, error) => {
      if (!current()) return;
      if (status === 'SUBSCRIBED') {
        if (entry.userId && entry.status !== 'connected') {
          const [kind, id] = topic.split(':');
          // Broadcast can miss changes before SUBSCRIBED or while the socket
          // reconnects. Fence fresh cached models before status listeners read.
          const prefixes = kind === 'templates' ? ['templates', 'template:', 'template-items:']
            : kind === 'user' ? ['projects:', 'my-tasks:', 'checklist-overview', 'notifications:']
            : kind === 'project' ? [`project:${id}`, `tasks:${id}`, `task-stats:${id}:`, 'checklist-overview']
            : [`task:${id}`, `task-context:${id}`, `task-participants:${id}`, `items:${id}:`, `assignees:${id}`, `task-role:${id}`, `last-editors:${id}`, `audit:${id}:`, 'checklist-overview'];
          void invalidateReadModels(entry.userId, prefixes, 'refresh').catch((error) => console.warn('[TaskTrace] reconnect invalidation failed', error));
        }
        broadcastStatus(entry, 'connected');
      }
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

  const userId = currentReadAccount() ?? options.userId ?? null;
  const previous = sharedChannels.get(topic);
  if (previous && (previous.userId !== userId || previous.accountEpoch !== readAccountEpoch())) {
    sharedChannels.delete(topic); previous.listeners.clear(); void supabase.removeChannel(previous.channel);
  }
  const entry = sharedChannels.get(topic) ?? createSharedChannel(topic, userId);
  const listener: Listener = { table, onEvent: options.onEvent, onStatus: options.onStatus };
  entry.listeners.add(listener);
  options.onStatus?.(entry.status, entry.message);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    entry.listeners.delete(listener);
    if (entry.listeners.size > 0) return;
    if (sharedChannels.get(topic) === entry) sharedChannels.delete(topic);
    void supabase.removeChannel(entry.channel);
  };
}

export function subscribeTable(table: string, options: SubscriptionOptions) {
  if (!scopeTopic(options)) {
    options.onStatus?.('error', 'Exactly one valid realtime scope is required');
    return () => undefined;
  }
  let cleanup: () => void = () => undefined;
  // A surviving React effect/connectivity callback must not recreate A's
  // subscription using B's credentials while React is cleaning up the screen.
  const account = currentReadAccount(); const epoch = readAccountEpoch();
  const connect = () => {
    cleanup(); cleanup = () => undefined;
    if (readAccountEpoch() !== epoch || currentReadAccount() !== account || (account && options.userId && account !== options.userId)) return;
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
  onChange: (event: RealtimeEvent) => void,
  onStatus?: (status: RealtimeStatus, message?: string) => void,
) {
  const invalidate = (event: RealtimeEvent) => {
    // The account-bound shared channel installs the fence before listeners.
    closeResourceRealtimeChannels();
    onChange(event);
  };
  return subscribeMany([
    { table: 'project_members', options: { userId, onEvent: invalidate, onStatus } },
    { table: 'task_members', options: { userId, onEvent: invalidate, onStatus } },
    { table: 'projects', options: { userId, onEvent: (event) => { if (event.eventType === 'DELETE') invalidate(event); }, onStatus } },
    { table: 'tasks', options: { userId, onEvent: (event) => { if (event.eventType === 'DELETE') invalidate(event); }, onStatus } },
  ]);
}

export function closeResourceRealtimeChannels() {
  for (const [topic, entry] of [...sharedChannels]) {
    // Global templates have no project/stage membership. Only account cleanup
    // closes this topic; a membership change must not strand its listeners.
    if (topic.startsWith('user:') || topic === 'templates') continue;
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
