import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticQueue, QUEUE_MAX_BYTES } from '@/lib/diagnostics/queue';
import { diagnosticEvent } from './client-error-fixtures';

let now: number, raw: string | null, online: boolean, active: boolean;
const send = vi.fn(), read = vi.fn(), write = vi.fn();
const make = () => new DiagnosticQueue({ now: () => now, active: () => active, canSend: () => online, read, write, send });
const event = (i = 0) => diagnosticEvent({ app_build: i.toString(16).padStart(8, '0') }, now);
beforeEach(() => {
  now = Date.parse('2026-10-28T12:00:00Z'); raw = null; online = true; active = true;
  send.mockReset().mockResolvedValue('accepted'); read.mockReset().mockImplementation(async () => raw);
  write.mockReset().mockImplementation(async (data, expected) => { if (expected !== raw) return false; raw = data; return true; });
});
describe('bounded independent diagnostic buffer', () => {
  it('sends one allowlisted error and deletes only its diagnostic envelope', async () => {
    const q = make(); await q.capture(event());
    expect(send).toHaveBeenCalledOnce(); expect(JSON.parse(raw!).queue).toEqual([]);
  });
  it('deduplicates an error storm, including across restarts', async () => {
    const q = make(); for (let i = 0; i < 100; i++) await q.capture(event());
    await make().capture(event()); expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(raw!).captured).toBe(1);
  });
  it('buffers offline, survives restart and sends on an existing lifecycle wake', async () => {
    online = false; await make().capture(event()); expect(send).not.toHaveBeenCalled();
    online = true; await make().flush(); expect(send).toHaveBeenCalledOnce();
  });
  it('bounds pending count, bytes, daily captures and expiry', async () => {
    online = false; const q = make(); for (let i = 0; i < 100; i++) await q.capture(event(i));
    const saved = JSON.parse(raw!); expect(saved.captured).toBe(20); expect(saved.queue).toHaveLength(10);
    expect(new TextEncoder().encode(raw!).length).toBeLessThan(QUEUE_MAX_BYTES);
    now += 3 * 86400_000; online = true; await make().flush(); expect(send).not.toHaveBeenCalled();
    expect(JSON.parse(raw!).queue).toEqual([]);
  });
  it('limits actual requests to 20 per UTC day, including retries', async () => {
    const q = make(); for (let i = 0; i < 25; i++) { await q.capture(event(i)); now += 31_000; }
    expect(send).toHaveBeenCalledTimes(20);
    await make().flush(); expect(send).toHaveBeenCalledTimes(20);
  });
  it('does not spin or retry more than twice after logging fails', async () => {
    send.mockRejectedValue(new Error('Data API or Edge unavailable'));
    const q = make(); await q.capture(event());
    await q.flush(); expect(send).toHaveBeenCalledOnce();
    now += 60_001; await make().flush(); expect(send).toHaveBeenCalledTimes(2);
    now += 60_001; await make().flush(); expect(send).toHaveBeenCalledTimes(2);
  });
  it('keeps a bounded in-memory fallback when reads or writes fail', async () => {
    write.mockRejectedValue(Object.assign(new Error(), { name: 'QuotaExceededError' }));
    const q = make(); await q.capture(event()); await q.capture(event()); expect(send).toHaveBeenCalledOnce();
    send.mockClear(); read.mockRejectedValue(new Error('IDB unavailable'));
    await make().capture(event(2)); expect(send).toHaveBeenCalledOnce();
  });
  it('never logs out another account or sends after its lifecycle ends', async () => {
    online = false; const q = make(); await q.capture(event()); active = false; online = true; q.stop(); await q.flush();
    expect(send).not.toHaveBeenCalled();
  });
  it('waits for authentication without consuming HTTP attempts', async () => {
    send.mockResolvedValue('wait'); const q = make(); await q.capture(event());
    expect(JSON.parse(raw!).requests).toBe(0); expect(JSON.parse(raw!).queue[0].attempts).toBe(0);
    send.mockResolvedValue('accepted'); await q.flush(); expect(JSON.parse(raw!).queue).toEqual([]);
  });
  it('bounds a transport ignoring AbortSignal without creating recursive events', async () => {
    vi.useFakeTimers(); send.mockImplementation(() => new Promise(() => {}));
    const q = make(); const task = q.capture(event()); await vi.advanceTimersByTimeAsync(6001); await task;
    expect(send).toHaveBeenCalledOnce(); q.stop(); vi.useRealTimers();
  });
});
