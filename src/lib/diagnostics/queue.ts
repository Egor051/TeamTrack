import { eventBytes, validClientErrorEvent, type ClientErrorEvent } from '../../../supabase/functions/_shared/client-error-schema';
import { eventFingerprint } from './event';

export const DIAGNOSTIC_KEY = 'diagnostics:client-errors:v1';
export const QUEUE_TTL_MS = 2 * 86400_000;
export const QUEUE_MAX_BYTES = 48 * 1024;
export const QUEUE_MAX_EVENTS = 10;
const DEDUP_MS = 15 * 60_000;
const REQUEST_INTERVAL_MS = 30_000;
type Pending = { event: ClientErrorEvent; attempts: number; next: number };
type Ledger = { version: 1; day: string; captured: number; requests: number; last: number; seen: { key: string; at: number }[]; queue: Pending[] };
type Delivery = 'accepted' | 'discard' | 'retry' | 'wait' | 'quota';
export type DiagnosticDependencies = {
  now: () => number;
  active: () => boolean;
  canSend: () => boolean;
  read: () => Promise<string | null>;
  write: (data: string, expected: string | null) => Promise<boolean>;
  send: (event: ClientErrorEvent, signal: AbortSignal) => Promise<Delivery>;
};
const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const empty = (now: number): Ledger => ({ version: 1, day: day(now), captured: 0, requests: 0, last: 0, seen: [], queue: [] });
function restore(raw: string | null, now: number): Ledger {
  try {
    if (!raw || new TextEncoder().encode(raw).byteLength > QUEUE_MAX_BYTES) return empty(now);
    const l = JSON.parse(raw) as Ledger;
    if (l.version !== 1 || !/^\d{4}-\d\d-\d\d$/.test(l.day) || ![l.captured, l.requests].every(n => Number.isInteger(n) && n >= 0 && n <= 20)
      || !Number.isFinite(l.last) || l.last < 0 || !Array.isArray(l.queue) || !Array.isArray(l.seen)) return empty(now);
    const queue = l.queue.filter(p => validClientErrorEvent(p.event) && Number.isInteger(p.attempts) && p.attempts >= 0 && p.attempts < 2
      && Number.isFinite(p.next) && Date.parse(p.event.occurred_at) > now - QUEUE_TTL_MS && Date.parse(p.event.occurred_at) <= now + 300_000).slice(-QUEUE_MAX_EVENTS);
    const seen = l.seen.filter(s => /^[a-f\d]{8}$/.test(s.key) && Number.isFinite(s.at) && s.at > now - DEDUP_MS && s.at <= now).slice(-20);
    return { ...empty(now), captured: l.day === day(now) ? l.captured : 0, requests: l.day === day(now) ? l.requests : 0, last: Math.min(l.last, now), seen, queue };
  } catch { return empty(now); }
}

/** A bounded diagnostic buffer using existing cache transactions, never outbox. */
export class DiagnosticQueue {
  private serial: Promise<unknown> = Promise.resolve();
  private fallback: Ledger;
  private controller: AbortController | null = null;
  private volatile = false;
  constructor(private readonly deps: DiagnosticDependencies) { this.fallback = empty(deps.now()); }
  private run(work: () => Promise<void>): Promise<void> {
    const task = this.serial.then(async () => { if (this.deps.active()) await work(); });
    this.serial = task.catch(() => undefined);
    return task.catch(() => undefined);
  }
  private async load(): Promise<{ ledger: Ledger; raw: string | null; durable: boolean }> {
    if (this.volatile) return { ledger: restore(JSON.stringify(this.fallback), this.deps.now()), raw: null, durable: false };
    try { const raw = await this.deps.read(); return { ledger: restore(raw, this.deps.now()), raw, durable: true }; }
    catch { this.volatile = true; return { ledger: restore(JSON.stringify(this.fallback), this.deps.now()), raw: null, durable: false }; }
  }
  private async save(ledger: Ledger, raw: string | null, durable: boolean): Promise<boolean> {
    this.fallback = ledger;
    const serialized = JSON.stringify(ledger);
    if (!this.deps.active() || eventBytes(ledger) > QUEUE_MAX_BYTES) return false;
    if (!durable || this.volatile) return true;
    try { return await this.deps.write(serialized, raw); }
    catch { this.volatile = true; return true; } // Broken IDB still permits a bounded in-memory report.
  }
  capture(event: ClientErrorEvent): Promise<void> {
    return this.run(async () => {
      if (!validClientErrorEvent(event)) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        const { ledger, raw, durable } = await this.load();
        const now = this.deps.now(), fingerprint = eventFingerprint(event);
        if (Date.parse(event.occurred_at) <= now - QUEUE_TTL_MS || ledger.captured >= 20 || ledger.seen.some(s => s.key === fingerprint)) return;
        ledger.captured++; ledger.seen.push({ key: fingerprint, at: now });
        ledger.queue.push({ event, attempts: 0, next: 0 }); ledger.queue = ledger.queue.slice(-QUEUE_MAX_EVENTS);
        if (await this.save(ledger, raw, durable)) break;
      }
      await this.deliver();
    });
  }
  flush(): Promise<void> { return this.run(() => this.deliver()); }
  private async deliver(): Promise<void> {
    if (!this.deps.active() || !this.deps.canSend()) return;
    const { ledger, raw, durable } = await this.load();
    const now = this.deps.now();
    if (ledger.requests >= 20 || (ledger.last && now - ledger.last < REQUEST_INTERVAL_MS)) return;
    const next = ledger.queue.find(p => p.next <= now);
    if (!next) { await this.save(ledger, raw, durable); return; }
    next.attempts++; next.next = now + 60_000; ledger.requests++; ledger.last = now;
    if (!await this.save(ledger, raw, durable) || !this.deps.active()) return;
    const claimed = JSON.stringify(ledger);
    const controller = this.controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    let result: Delivery = 'retry';
    try {
      // Abort plus a settled race also bounds transports ignoring AbortSignal.
      result = await Promise.race([this.deps.send(next.event, controller.signal), new Promise<Delivery>(resolve => {
        controller.signal.addEventListener('abort', () => resolve('retry'), { once: true });
      })]);
    } catch { /* Logging failure never emits another diagnostic event. */ }
    finally { clearTimeout(timeout); if (this.controller === controller) this.controller = null; }
    if (!this.deps.active()) return;
    if (result === 'wait') { next.attempts--; ledger.requests--; ledger.last = 0; next.next = 0; }
    else if (result !== 'retry' || next.attempts >= 2) ledger.queue = ledger.queue.filter(p => p.event.event_id !== next.event.event_id);
    if (result === 'quota') ledger.requests = 20;
    await this.save(ledger, claimed, durable);
  }
  stop(): void { this.controller?.abort(); }
  settled(): Promise<unknown> { return this.serial; }
}
