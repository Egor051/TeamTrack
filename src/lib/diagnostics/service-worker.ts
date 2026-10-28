let version: string | null = null;
let generation = 0;
/** Version is supplied by the controlling worker, independently of page JS. */
export function knownServiceWorkerVersion(): string | null { return version; }
export async function readServiceWorkerVersion(): Promise<void> {
  const request = ++generation;
  version = null;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !navigator.serviceWorker.controller || typeof MessageChannel === 'undefined') return;
  const worker = navigator.serviceWorker.controller;
  await new Promise<void>(resolve => {
    const channel = new MessageChannel();
    const finish = () => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(); };
    const timer = setTimeout(finish, 500);
    channel.port1.onmessage = ({ data }) => {
      if (request === generation && navigator.serviceWorker.controller === worker && data?.type === 'TASKTRACE_SW_VERSION'
        && typeof data.version === 'string' && /^[a-f\d]{16,64}$/.test(data.version)) version = data.version;
      finish();
    };
    try { navigator.serviceWorker.controller!.postMessage({ type: 'TASKTRACE_SW_VERSION' }, [channel.port2]); }
    catch { finish(); }
  });
}
