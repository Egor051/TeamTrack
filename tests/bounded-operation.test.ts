import { afterEach, expect, it, vi } from 'vitest';
import { boundedOperation } from '@/lib/connectivity/deadline';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('times out a signal-ignoring promise and disposes its timer', async () => {
  vi.useFakeTimers(); let signal: AbortSignal | undefined;
  const pending = boundedOperation((next) => { signal = next; return new Promise<never>(() => undefined); }, 20_000);
  const checked = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(20_000); await checked;
  expect(signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
it('cancels a hanging operation immediately without waiting for its deadline', async () => {
  vi.useFakeTimers(); const controller = new AbortController();
  const pending = boundedOperation(() => new Promise<never>(() => undefined), 20_000, controller.signal);
  const checked = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); await checked;
  expect(vi.getTimerCount()).toBe(0);
});
it('never starts an already cancelled operation and cleans up successful operations', async () => {
  vi.useFakeTimers(); const controller = new AbortController(); controller.abort(); const work = vi.fn();
  await expect(boundedOperation(work, 20_000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(work).not.toHaveBeenCalled();
  expect(await boundedOperation(async () => 'ready', 20_000)).toBe('ready');
  expect(vi.getTimerCount()).toBe(0);
});
