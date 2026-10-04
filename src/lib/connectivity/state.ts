import { isTransportFailure } from './errors';
import { boundedOperation } from './deadline';

export type ConnectivityState = 'online' | 'degraded' | 'offline';
export const CONNECTIVITY_PROBE_INTERVAL_MS = 30_000;
const listeners = new Set<(state: ConnectivityState) => void>();
// Startup remains optimistic when the browser reports online. A transport
// failure closes the network path until a successful shared probe/request.
let state: ConnectivityState = 'online';
let probe: (() => Promise<void>) | null = null;
let inFlight: Promise<void> | null = null;
let probeController: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let owners = 0;
let generation = 0;

export function getConnectivityState(): ConnectivityState {
  return browserIsOffline() ? 'offline' : state;
}
export function browserIsOffline(): boolean { return typeof navigator !== 'undefined' && navigator.onLine === false; }
export function usesLocalReads(): boolean { return getConnectivityState() !== 'online'; }
function change(next: ConnectivityState): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener(getConnectivityState());
}
export function subscribeConnectivity(listener: (state: ConnectivityState) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function reportConnectivitySuccess(): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  if (timer) { clearTimeout(timer); timer = null; }
  change('online');
}
function scheduleProbe(): void {
  if (!probe || timer || getConnectivityState() !== 'degraded') return;
  timer = setTimeout(() => { timer = null; void revalidateConnectivity(); }, CONNECTIVITY_PROBE_INTERVAL_MS);
}
export function reportConnectivityFailure(error: unknown): void {
  if (!isTransportFailure(error)) return;
  change(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'degraded');
  scheduleProbe();
}
export function reportBrowserConnectivity(connected: boolean): void {
  if (!connected) {
    generation += 1; probeController?.abort(); probeController = null; inFlight = null;
    if (timer) { clearTimeout(timer); timer = null; } change('offline');
  }
  else if (state === 'offline') void revalidateConnectivity();
}
export function revalidateConnectivity(restart = false): Promise<void> {
  if (restart) { generation += 1; probeController?.abort(); probeController = null; inFlight = null; }
  if (inFlight) return inFlight;
  if (!probe || (typeof navigator !== 'undefined' && navigator.onLine === false)) return Promise.resolve();
  const currentGeneration = generation;
  const controller = new AbortController(); probeController = controller;
  const task = (async () => {
    try { await boundedOperation(() => probe!(), 45_000, controller.signal); if (generation === currentGeneration) reportConnectivitySuccess(); }
    catch (error) { if (generation === currentGeneration) reportConnectivityFailure(error); }
  })().finally(() => { if (inFlight === task) { inFlight = null; probeController = null; } if (generation === currentGeneration) scheduleProbe(); });
  inFlight = task;
  return task;
}
const onlineEvent = () => { void revalidateConnectivity(); };
const offlineEvent = () => reportBrowserConnectivity(false);
export function monitorConnectivity(check: () => Promise<void>): () => void {
  owners += 1; probe = check;
  if (owners === 1 && typeof window !== 'undefined') {
    window.addEventListener('online', onlineEvent); window.addEventListener('offline', offlineEvent);
  }
  if (getConnectivityState() === 'offline') change('offline');
  if (state === 'offline' && !(typeof navigator !== 'undefined' && navigator.onLine === false)) void revalidateConnectivity();
  scheduleProbe();
  return () => {
    owners -= 1;
    if (owners > 0) return;
    generation += 1; probeController?.abort(); probeController = null; probe = null; inFlight = null;
    if (timer) clearTimeout(timer);
    timer = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onlineEvent); window.removeEventListener('offline', offlineEvent);
    }
  };
}
// Also used to isolate runtime state between regression tests.
export function resetConnectivity(): void {
  generation += 1;
  probeController?.abort(); probeController = null;
  if (timer) clearTimeout(timer);
  timer = null; inFlight = null; state = 'online';
}
