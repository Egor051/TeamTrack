import AsyncStorage from '@react-native-async-storage/async-storage';
import { emailSendRetryDelay, mapSupabaseAuthError } from '@/lib/errors/auth-errors';

export type AuthEmailOperation = 'signup' | 'recovery';
export const AUTH_EMAIL_COOLDOWN_MS = 60_000;

export function authEmailCooldownKey(operation: AuthEmailOperation, email: string): string {
  return `auth-email-cooldown:${operation}:${email.trim().toLowerCase()}`;
}

export function cooldownSeconds(until: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

// Fallback when browser/native storage is unavailable. Only deadlines are
// stored, without credentials, session data or a separate list of addresses.
const deadlines = new Map<string, number>();
const requests = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
const storageQueue = new Map<string, Promise<unknown>>();

function storageTask<T>(key: string, work: () => Promise<T>): Promise<T> {
  const task = (storageQueue.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  storageQueue.set(key, task);
  void task.finally(() => {
    if (storageQueue.get(key) === task) storageQueue.delete(key);
  }).catch(() => undefined);
  return task;
}

function notify(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

export function subscribeEmailCooldown(key: string, listener: () => void): () => void {
  const subscribers = listeners.get(key) ?? new Set();
  subscribers.add(listener);
  listeners.set(key, subscribers);
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) listeners.delete(key);
  };
}

export function emailRequestPending(key: string): boolean {
  return requests.has(key);
}

export function readEmailCooldown(key: string): Promise<number> {
  return storageTask(key, async () => {
    let stored: string | null = null;
    try { stored = await AsyncStorage.getItem(key); } catch { /* Use the memory fallback. */ }
    const parsed = Number(stored);
    const until = Math.max(Number.isSafeInteger(parsed) ? parsed : 0, deadlines.get(key) ?? 0);
    if (cooldownSeconds(until) > 0) return until;
    deadlines.delete(key);
    if (stored !== null) {
      try { await AsyncStorage.removeItem(key); } catch { /* Expired values are ignored regardless. */ }
    }
    return 0;
  });
}

function saveEmailCooldown(key: string, until: number): Promise<void> {
  // Slow or rejected persistence must not turn a successful Auth call into a
  // failure or leave the button enabled.
  deadlines.set(key, until);
  notify(key);
  return storageTask(key, async () => {
    try { await AsyncStorage.setItem(key, String(until)); } catch { /* Use the memory fallback. */ }
  });
}

class LocalEmailRequestError extends Error {
  constructor(public code: 'auth_email_cooldown' | 'auth_email_request_pending') {
    super(mapSupabaseAuthError({ code }));
  }
}

/** Guard all sending entry points, including Enter and autofilled addresses
 * which have not emitted a React input event. */
export async function sendAuthEmail<T>(operation: AuthEmailOperation, email: string, send: () => Promise<T>,
  shouldStartCooldown: (result: T) => boolean = () => true): Promise<T> {
  const key = authEmailCooldownKey(operation, email);
  if (requests.has(key)) throw new LocalEmailRequestError('auth_email_request_pending');
  requests.add(key);
  notify(key);
  try {
    if (cooldownSeconds(await readEmailCooldown(key)) > 0) throw new LocalEmailRequestError('auth_email_cooldown');
    const result = await send();
    if (shouldStartCooldown(result)) await saveEmailCooldown(key, Date.now() + AUTH_EMAIL_COOLDOWN_MS);
    return result;
  } catch (error) {
    const delay = emailSendRetryDelay(error);
    // This code also covers the hourly limit; only the verified GoTrue
    // frequency-limit message supplies a usable remaining interval.
    if (delay !== null) await saveEmailCooldown(key, Date.now() + delay);
    throw error;
  } finally {
    requests.delete(key);
    notify(key);
  }
}
