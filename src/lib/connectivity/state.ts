import { isTransportFailure } from './errors';
import { boundedOperation } from './deadline';
import { getNetworkFacts, resetOfflineRuntime, setNetworkFacts, subscribeOfflineRuntime } from '@/lib/local-cache/runtime-state';

export type ConnectivityState = 'online' | 'degraded' | 'offline';
export const CONNECTIVITY_PROBE_INTERVAL_MS = 30_000;
const listeners = new Set<(state: ConnectivityState) => void>();
// Startup remains optimistic when the browser reports online. A transport
// failure closes the network path until a successful shared probe/request.
let probe: (() => Promise<void>) | null = null;
let inFlight: Promise<void> | null = null;
let probeController: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let owners = 0;
let generation = 0;
let requestEpoch = 0;
export function connectivityRequestEpoch(): number { return requestEpoch; }

export function getConnectivityState(): ConnectivityState {
  const facts = getNetworkFacts();
  return browserIsOffline() || facts.physical === 'disconnected' ? 'offline'
    : facts.backend === 'unavailable' ? 'degraded' : 'online';
}
export function browserIsOffline(): boolean { return typeof navigator !== 'undefined' && navigator.onLine === false; }
export function usesLocalReads(): boolean { return getConnectivityState() !== 'online'; }
function change(next: ConnectivityState): void {
  setNetworkFacts(next === 'offline' ? { physical: 'disconnected', backend: 'unavailable' }
    : { physical: 'connected', backend: next === 'online' ? 'reachable' : 'unavailable', checkedAt: Date.now() });
}
let published: ConnectivityState = 'online';
subscribeOfflineRuntime((userId) => {
  if (userId !== null) return;
  const next = getConnectivityState();
  if (published === next) return;
  published = next; for (const listener of listeners) listener(next);
});
export function subscribeConnectivity(listener: (state: ConnectivityState) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function reportConnectivitySuccess(epoch?: number): void {
  if (epoch !== undefined && epoch !== requestEpoch) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  // Recovery opens the network path only after its Auth + Data API check.
  if (inFlight) return;
  if (timer) { clearTimeout(timer); timer = null; }
  change('online');
}
function scheduleProbe(): void {
  if (!probe || timer || getConnectivityState() !== 'degraded') return;
  timer = setTimeout(() => { timer = null; void revalidateConnectivity(); }, CONNECTIVITY_PROBE_INTERVAL_MS);
}
export function reportConnectivityFailure(error: unknown): void {
  if (!isTransportFailure(error)) return;
  requestEpoch += 1;
  change(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'degraded');
  scheduleProbe();
}
export function reportBrowserConnectivity(connected: boolean): void {
  if (!connected) {
    requestEpoch += 1;
    generation += 1; probeController?.abort(); probeController = null; inFlight = null;
    if (timer) { clearTimeout(timer); timer = null; } change('offline');
  }
  else {
    setNetworkFacts({ physical: 'connected' });
    if (getNetworkFacts().backend !== 'reachable') void revalidateConnectivity();
  }
}
export function revalidateConnectivity(restart = false): Promise<void> {
  if (restart) { generation += 1; probeController?.abort(); probeController = null; inFlight = null; }
  if (inFlight) return inFlight;
  if (!probe || (typeof navigator !== 'undefined' && navigator.onLine === false)) return Promise.resolve();
  const currentGeneration = generation;
  const controller = new AbortController(); probeController = controller;
  const task = (async () => {
    try {
      await boundedOperation(() => probe!(), 45_000, controller.signal);
      if (generation === currentGeneration && !browserIsOffline()) {
        if (timer) { clearTimeout(timer); timer = null; }
        change('online');
      }
    }
    catch (error) { if (generation === currentGeneration) reportConnectivityFailure(error); }
  })().finally(() => { if (inFlight === task) { inFlight = null; probeController = null; } if (generation === currentGeneration) scheduleProbe(); });
  inFlight = task;
  return task;
}
const onlineEvent = () => { reportBrowserConnectivity(true); void revalidateConnectivity(); };
const offlineEvent = () => reportBrowserConnectivity(false);
const resumeEvent = () => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (browserIsOffline()) reportBrowserConnectivity(false);
  else { reportBrowserConnectivity(true); if (usesLocalReads()) void revalidateConnectivity(); }
};
export function monitorConnectivity(check: () => Promise<void>): () => void {
  owners += 1; probe = check;
  if (owners === 1 && typeof window !== 'undefined') {
    window.addEventListener('online', onlineEvent); window.addEventListener('offline', offlineEvent);
    window.addEventListener('focus', resumeEvent); window.addEventListener('pageshow', resumeEvent);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resumeEvent);
  }
  if (getConnectivityState() === 'offline') change('offline');
  if (getNetworkFacts().physical === 'disconnected' && !browserIsOffline()) reportBrowserConnectivity(true);
  scheduleProbe();
  return () => {
    owners -= 1;
    if (owners > 0) return;
    generation += 1; probeController?.abort(); probeController = null; probe = null; inFlight = null;
    if (timer) clearTimeout(timer);
    timer = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onlineEvent); window.removeEventListener('offline', offlineEvent);
      window.removeEventListener('focus', resumeEvent); window.removeEventListener('pageshow', resumeEvent);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resumeEvent);
    }
  };
}
// Also used to isolate runtime state between regression tests.
export function resetConnectivity(): void {
  generation += 1;
  requestEpoch += 1;
  probeController?.abort(); probeController = null;
  if (timer) clearTimeout(timer);
  timer = null; inFlight = null; resetOfflineRuntime(); published = 'online';
}
