import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { knownServiceWorkerVersion, readServiceWorkerVersion } from '@/lib/diagnostics/service-worker';

type Port = { close: ReturnType<typeof vi.fn>; onmessage?: (event: { data: unknown }) => void };
const channels: { port1: Port; port2: Port }[] = [];
const worker = { postMessage: vi.fn() };
let serviceWorker: { controller: typeof worker | null };
beforeEach(() => {
  channels.length = 0; worker.postMessage.mockReset(); serviceWorker = { controller: worker };
  vi.stubGlobal('navigator', { serviceWorker });
  vi.stubGlobal('MessageChannel', class {
    port1: Port = { close: vi.fn() }; port2: Port = { close: vi.fn() };
    constructor() { channels.push(this); }
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('reads a controlling worker build and clears it after that controller disappears', async () => {
  const reading = readServiceWorkerVersion();
  channels[0].port1.onmessage?.({ data: { type: 'TASKTRACE_SW_VERSION', version: 'a'.repeat(32) } });
  await reading; expect(knownServiceWorkerVersion()).toBe('a'.repeat(32));
  serviceWorker.controller = null; await readServiceWorkerVersion();
  expect(knownServiceWorkerVersion()).toBeNull(); expect(channels[0].port1.close).toHaveBeenCalledOnce();
});
it('ignores a late response from a superseded controller', async () => {
  const older = readServiceWorkerVersion();
  serviceWorker.controller = { postMessage: vi.fn() };
  const newer = readServiceWorkerVersion();
  channels[1].port1.onmessage?.({ data: { type: 'TASKTRACE_SW_VERSION', version: 'b'.repeat(32) } }); await newer;
  channels[0].port1.onmessage?.({ data: { type: 'TASKTRACE_SW_VERSION', version: 'a'.repeat(32) } }); await older;
  expect(knownServiceWorkerVersion()).toBe('b'.repeat(32));
});
it('bounds an old worker without version support and does not accept arbitrary response text', async () => {
  vi.useFakeTimers(); const reading = readServiceWorkerVersion();
  await vi.advanceTimersByTimeAsync(501); await reading;
  expect(knownServiceWorkerVersion()).toBeNull(); expect(channels[0].port2.close).toHaveBeenCalledOnce();
  const invalid = readServiceWorkerVersion();
  channels[1].port1.onmessage?.({ data: { type: 'TASKTRACE_SW_VERSION', version: 'private-text-token' } }); await invalid;
  expect(knownServiceWorkerVersion()).toBeNull();
});
