type ReadModelCommit = { userId: string; keys: string[]; source: 'read' | 'preparation' };
const listeners = new Set<(commit: ReadModelCommit) => void>();
let channel: BroadcastChannel | null = null;
// UI queries and snapshot RPCs need not serialize keys/rows in the same order.
// Reordering the same overview must not schedule a new account preparation.
export function overviewReadModelChanged(before: string | null, after: string): boolean {
  if (before === after) return false;
  if (before === null) return true;
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical).sort((a, b) => {
      const left = a as { id?: string }; const right = b as { id?: string };
      return typeof left?.id === 'string' && typeof right?.id === 'string' ? left.id.localeCompare(right.id) : 0;
    });
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return value;
  };
  try { return JSON.stringify(canonical(JSON.parse(before))) !== JSON.stringify(canonical(JSON.parse(after))); }
  catch { return true; }
}
function connect() {
  if (channel || typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel('tasktrace-read-models');
  channel.onmessage = (event: MessageEvent) => {
    const value = event.data as Partial<ReadModelCommit> | null;
    if (typeof value?.userId !== 'string' || !Array.isArray(value.keys) || !value.keys.every((key) => typeof key === 'string')
      || !['read', 'preparation'].includes(value.source ?? '')) return;
    listeners.forEach((listener) => listener(value as ReadModelCommit));
  };
}
export function subscribeReadModelCommits(listener: (commit: ReadModelCommit) => void): () => void {
  connect(); listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function announceReadModelCommit(userId: string, keys: string[], source: ReadModelCommit['source']): void {
  if (!keys.length) return;
  connect();
  const commit = { userId, keys, source };
  listeners.forEach((listener) => listener(commit));
  channel?.postMessage(commit);
}
