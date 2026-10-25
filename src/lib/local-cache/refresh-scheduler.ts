export const READ_COALESCE_MS = 150;
export function createReadRefreshScheduler(refresh: () => Promise<unknown>, delay = READ_COALESCE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false; let dirty = false; let urgent = false; let disposed = false;
  const run = () => {
    if (disposed) return;
    timer = null;
    if (running) { dirty = true; return; }
    running = true; dirty = false; urgent = false;
    let work: Promise<unknown>;
    try { work = refresh(); } catch (error) { work = Promise.reject(error); }
    void Promise.resolve(work).catch(() => undefined).finally(() => {
      running = false;
      if (!disposed && dirty) request(urgent);
    });
  };
  const request = (immediate = false) => {
    if (disposed) return;
    if (running) { dirty = true; urgent ||= immediate; return; }
    if (immediate) { if (timer) clearTimeout(timer); timer = null; run(); }
    else if (!timer) timer = setTimeout(run, delay);
  };
  return { request, dispose() { disposed = true; if (timer) clearTimeout(timer); timer = null; } };
}
