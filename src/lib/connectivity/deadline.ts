// RN's AbortSignal polyfill has no static timeout(). Keep deadlines portable.
export function requestDeadline(milliseconds: number) {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => { expired = true; controller.abort(); }, milliseconds);
  return { signal: controller.signal, expired: () => expired, dispose: () => clearTimeout(timer) };
}
