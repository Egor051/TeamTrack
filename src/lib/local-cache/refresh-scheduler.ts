export const READ_COALESCE_MS = 150;
export function createReadRefreshScheduler(refresh: () => Promise<unknown>, delay = READ_COALESCE_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false; let dirty = false; let disposed = false;
  const run = () => {
    if (disposed) return;
    timer = null;
    if (running) { dirty = true; return; }
    running = true; dirty = false;
    void refresh().catch(() => undefined).finally(() => {
      running = false;
      if (!disposed && dirty) request();
    });
  };
  const request = (immediate = false) => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    if (immediate) run(); else timer = setTimeout(run, delay);
  };
  return { request, dispose() { disposed = true; if (timer) clearTimeout(timer); timer = null; } };
}
