import { isTransportFailure, ServiceUnavailableError } from './errors';
import { boundedOperation } from './deadline';
import { getNetworkFacts, resetOfflineRuntime, setNetworkFacts, subscribeOfflineRuntime, type NetworkFacts } from '@/lib/local-cache/runtime-state';

export type ConnectivityState = 'online' | 'degraded' | 'offline';
export type ConnectivityProbeResult = { authorizationRequired: true } | void;
export const CONNECTIVITY_PROBE_INTERVAL_MS = 30_000;
export const CONNECTIVITY_PROBE_TIMEOUT_MS = 12_000;
export const OFFLINE_HINT_RECHECK_MS = 120_000;
const listeners = new Set<(state: ConnectivityState) => void>();
let probe: ((signal: AbortSignal) => Promise<ConnectivityProbeResult>) | null = null;
let inFlight: Promise<void> | null = null;
let probeController: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let owners = 0;
let generation = 0;
let requestEpoch = 0;
let failures = 0;
let lastProbeAt: number | null = null;
let checkRequested = false;
// A successful explicit probe is stronger evidence than a stale browser hint.
let verifiedWhileBrowserOffline = false;
export function connectivityRequestEpoch(): number { return requestEpoch; }

export function browserIsOffline(): boolean { return typeof navigator !== 'undefined' && navigator.onLine === false; }
export function getConnectivityState(): ConnectivityState {
  const facts = getNetworkFacts();
  return (browserIsOffline() && !verifiedWhileBrowserOffline) || facts.physical === 'disconnected' ? 'offline'
    : facts.backend === 'unavailable' ? 'degraded' : 'online';
}
export function usesLocalReads(): boolean { return getConnectivityState() !== 'online'; }
function change(next: ConnectivityState, issue: NetworkFacts['issue'] = null): void {
  setNetworkFacts({ physical: next === 'offline' ? 'disconnected' : 'connected',
    backend: next === 'online' ? 'reachable' : 'unavailable', issue, checkedAt: Date.now() });
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
function clearTimer(): void { if (timer) clearTimeout(timer); timer = null; }
export function reportConnectivitySuccess(epoch?: number): void {
  if (epoch !== undefined && epoch !== requestEpoch) return;
  if (browserIsOffline() && !verifiedWhileBrowserOffline) return;
  // A single successful endpoint cannot invalidate the shared service check.
  if (inFlight || (probe && usesLocalReads())) return;
  requestEpoch += 1; failures = 0;
  if (!checkRequested) clearTimer();
  change('online');
}
function scheduleProbe(delay = Math.min(120_000, CONNECTIVITY_PROBE_INTERVAL_MS * 2 ** Math.min(failures, 2))): void {
  if (!probe || timer || (getConnectivityState() === 'online' && !checkRequested)) return;
  const wait = browserIsOffline() && !verifiedWhileBrowserOffline ? Math.max(delay, OFFLINE_HINT_RECHECK_MS) : delay;
  timer = setTimeout(() => {
    timer = null;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { scheduleProbe(); return; }
    // A rare service check also recovers a stale negative browser hint. Normal
    // offline navigation still reads only local data between these checks.
    void revalidateConnectivity(false, true);
  }, wait);
}
// Confirmed failures (browser events or the shared probe) close the network path.
export function reportConnectivityFailure(error: unknown, epoch?: number): void {
  if ((epoch !== undefined && epoch !== requestEpoch) || !isTransportFailure(error)) return;
  requestEpoch += 1;
  const issue = error instanceof ServiceUnavailableError ? error.service : 'network';
  change(browserIsOffline() && !verifiedWhileBrowserOffline ? 'offline' : 'degraded', issue);
  scheduleProbe();
}
// A failed request may be an isolated endpoint, timeout or CORS issue. Its
// caller can use cache, but only a service probe changes the shared status.
export function reportRequestFailure(error: unknown, epoch: number): void {
  if (epoch !== requestEpoch || !isTransportFailure(error)) return;
  if (!probe) { reportConnectivityFailure(error, epoch); return; }
  if (!inFlight) { checkRequested = true; scheduleProbe(250); }
}
function cancelProbe(): void {
  generation += 1; requestEpoch += 1;
  probeController?.abort(); probeController = null; inFlight = null;
}
export function reportBrowserConnectivity(connected: boolean): void {
  if (!connected) {
    const alreadyDisconnected = getNetworkFacts().physical === 'disconnected';
    verifiedWhileBrowserOffline = false;
    if (!alreadyDisconnected || inFlight) cancelProbe();
    lastProbeAt = null;
    if (!alreadyDisconnected) clearTimer();
    change('offline', 'network'); scheduleProbe();
  } else {
    if (getNetworkFacts().physical === 'disconnected') { lastProbeAt = null; clearTimer(); }
    if (!browserIsOffline()) verifiedWhileBrowserOffline = false;
    setNetworkFacts({ physical: 'connected' });
    if (getNetworkFacts().backend !== 'reachable') void revalidateConnectivity();
  }
}
export function revalidateConnectivity(restart = false, checkOfflineHint = false): Promise<void> {
  if (restart) { failures = 0; cancelProbe(); clearTimer(); }
  if (inFlight) return inFlight;
  if (!probe) return Promise.resolve();
  // Coalesce foreground/event bursts after a completed probe as well.
  if (!restart && lastProbeAt !== null && Date.now() - lastProbeAt < 1000) {
    if (usesLocalReads() || checkRequested) { clearTimer(); scheduleProbe(1000 - (Date.now() - lastProbeAt)); }
    return Promise.resolve();
  }
  if (!restart && !checkOfflineHint && browserIsOffline() && !verifiedWhileBrowserOffline) { scheduleProbe(); return Promise.resolve(); }
  clearTimer();
  checkRequested = false;
  lastProbeAt = Date.now();
  const currentGeneration = generation;
  const epoch = ++requestEpoch;
  const check = probe;
  const controller = new AbortController(); probeController = controller;
  const task = (async () => {
    try {
      const result = await boundedOperation((signal) => check(signal), CONNECTIVITY_PROBE_TIMEOUT_MS, controller.signal);
      if (generation === currentGeneration && epoch === requestEpoch) {
        requestEpoch += 1; failures = 0; verifiedWhileBrowserOffline = browserIsOffline();
        change('online', result?.authorizationRequired ? 'authorization' : null);
      }
    } catch (error) {
      if (generation === currentGeneration && epoch === requestEpoch) {
        // Unexpected failures must settle and retry too, never leave a lock.
        reportConnectivityFailure(isTransportFailure(error) ? error : new ServiceUnavailableError('data-service'), epoch);
        failures += 1;
      }
    }
  })().finally(() => {
    if (inFlight === task) { inFlight = null; probeController = null; }
    if (generation === currentGeneration) scheduleProbe();
  });
  inFlight = task;
  return task;
}
const onlineEvent = () => { reportBrowserConnectivity(true); void revalidateConnectivity(); };
const offlineEvent = () => reportBrowserConnectivity(false);
const resumeEvent = () => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (browserIsOffline() && !verifiedWhileBrowserOffline) reportBrowserConnectivity(false);
  else {
    reportBrowserConnectivity(true);
    const checkedAt = getNetworkFacts().checkedAt;
    if (usesLocalReads() || checkedAt === null || Date.now() - checkedAt >= CONNECTIVITY_PROBE_INTERVAL_MS)
      void revalidateConnectivity();
  }
};
export function monitorConnectivity(check: (signal: AbortSignal) => Promise<ConnectivityProbeResult>): () => void {
  owners += 1; probe = check;
  if (owners === 1 && typeof window !== 'undefined') {
    window.addEventListener('online', onlineEvent); window.addEventListener('offline', offlineEvent);
    window.addEventListener('focus', resumeEvent); window.addEventListener('pageshow', resumeEvent);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resumeEvent);
  }
  if (getConnectivityState() === 'offline') change('offline', 'network');
  if (getNetworkFacts().physical === 'disconnected' && !browserIsOffline()) reportBrowserConnectivity(true);
  scheduleProbe();
  return () => {
    owners -= 1;
    if (owners > 0) return;
    cancelProbe(); probe = null; clearTimer();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onlineEvent); window.removeEventListener('offline', offlineEvent);
      window.removeEventListener('focus', resumeEvent); window.removeEventListener('pageshow', resumeEvent);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resumeEvent);
    }
  };
}
export function resetConnectivity(): void {
  cancelProbe(); clearTimer(); failures = 0; lastProbeAt = null; checkRequested = false; verifiedWhileBrowserOffline = false;
  resetOfflineRuntime(); published = 'online';
}
