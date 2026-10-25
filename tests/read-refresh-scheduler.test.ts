import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createReadRefreshScheduler } from '@/lib/local-cache/refresh-scheduler';
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
it('a burst of related events produces one refresh in 150ms', async () => {
  const load = vi.fn(async () => {}); const s = createReadRefreshScheduler(load);
  for (let i = 0; i < 10; i++) s.request();
  await vi.advanceTimersByTimeAsync(149); expect(load).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledOnce(); s.dispose();
});
it('an ACL signal bypasses the timer and disposal cancels queued work', async () => {
  const load = vi.fn(async () => {}); const s = createReadRefreshScheduler(load);
  s.request(); s.request(true); expect(load).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(200); expect(load).toHaveBeenCalledOnce(); s.request(); s.dispose();
  await vi.runAllTimersAsync(); expect(load).toHaveBeenCalledOnce();
});
it('events during a refresh request one subsequent refresh without overlapping work', async () => {
  let finish!: () => void; const load = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const s = createReadRefreshScheduler(load); s.request(true);
  for (let i = 0; i < 5; i++) s.request(); await vi.advanceTimersByTimeAsync(150); expect(load).toHaveBeenCalledOnce();
  finish(); await vi.advanceTimersByTimeAsync(150); expect(load).toHaveBeenCalledTimes(2); s.dispose(); finish();
});
it('B07 starts reads during a continuous stream instead of waiting for silence', async () => {
  const load = vi.fn(async () => {}); const s = createReadRefreshScheduler(load);
  for (let n = 0; n < 300; n++) { s.request(); await vi.advanceTimersByTimeAsync(100); }
  expect(load.mock.calls.length).toBeGreaterThanOrEqual(100);
  s.dispose();
});
it('recovers after a synchronous throw and never restarts after disposal in flight', async () => {
  const load = vi.fn<() => Promise<void>>().mockImplementationOnce(() => { throw Error('sync'); }).mockResolvedValue(undefined);
  const s = createReadRefreshScheduler(load); s.request(); await vi.advanceTimersByTimeAsync(150);
  s.request(); await vi.advanceTimersByTimeAsync(150); expect(load).toHaveBeenCalledTimes(2); s.dispose();
  let finish!: () => void; const next = vi.fn(() => new Promise<void>(r => { finish = r; }));
  const pending = createReadRefreshScheduler(next); pending.request(true); await vi.advanceTimersByTimeAsync(0);
  pending.request(); pending.dispose(); finish(); await vi.advanceTimersByTimeAsync(500);
  expect(next).toHaveBeenCalledOnce();
});
