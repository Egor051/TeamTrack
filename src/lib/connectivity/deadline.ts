// RN's AbortSignal polyfill has no static timeout(). Keep deadlines portable.
export function requestDeadline(milliseconds: number) {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(); }, milliseconds);
  return { signal: controller.signal, expired: () => expired, dispose: () => clearTimeout(timer) };
}

// Abort alone cannot settle an SDK/auth/storage promise that ignores its signal.
// Race every operation, and detach all timers/listeners when either side settles.
export async function boundedOperation<T>(work: (signal: AbortSignal) => PromiseLike<T>, milliseconds: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = () => { const error = new Error('Operation cancelled'); error.name = 'AbortError'; reject(error); controller.abort(); };
    timer = setTimeout(() => { const error = new Error('Operation timed out'); error.name = 'TimeoutError'; reject(error); controller.abort(); }, milliseconds);
    parent?.addEventListener('abort', cancel, { once: true });
  });
  try {
    if (parent?.aborted) cancel();
    return await Promise.race([stopped, Promise.resolve().then(() => {
      if (controller.signal.aborted) { const error = new Error('Operation cancelled'); error.name = 'AbortError'; throw error; }
      return work(controller.signal);
    })]);
  } finally { if (timer) clearTimeout(timer); parent?.removeEventListener('abort', cancel); }
}
