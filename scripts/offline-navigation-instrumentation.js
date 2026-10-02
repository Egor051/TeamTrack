// Installed only by the timing smoke, before the production bundle executes.
(() => {
  const probe = window.__navigationProbe = {
    startAt: 0, renderedAt: null, events: [], expected: sessionStorage.getItem('timing:expected'),
    start(expected) {
      this.expected = expected; this.startAt = performance.now(); this.renderedAt = null; this.events = [];
      this.record('route_started');
    },
    record(event, key) { this.events.push({ event, key, ms: performance.now() - this.startAt }); },
  };
  probe.record('route_started');
  const originalFetch = window.fetch;
  window.fetch = async function(input, init) {
    const url = String(input.url || input);
    if (!url.includes('127.0.0.1:55431')) return originalFetch.call(this, input, init);
    const key = new URL(url).pathname + new URL(url).search;
    const probeRequest = new URL(url).pathname === '/auth/v1/health' || url.includes('select=id&limit=0');
    probe.record(probeRequest ? 'connectivity_probe_started' : 'network_started', key);
    try {
      if (sessionStorage.getItem('timing:dead') === 'true') {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        throw new TypeError('Failed to fetch');
      }
      const response = await originalFetch.call(this, input, init);
      probe.record(probeRequest
        ? (response.ok ? 'connectivity_probe_finished' : 'connectivity_probe_failed')
        : (response.ok ? 'network_finished' : 'network_failed'), key);
      return response;
    } catch (error) { probe.record(probeRequest ? 'connectivity_probe_failed' : 'network_failed', key); throw error; }
  };
  const originalGet = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function(key) {
    probe.record('cache_read_started', String(key));
    const request = originalGet.call(this, key);
    request.addEventListener('success', () => probe.record('cache_read_finished', String(key)));
    return request;
  };
  const originalStorageGet = Storage.prototype.getItem;
  Storage.prototype.getItem = function(key) {
    if (key.endsWith('-auth-token')) probe.record('session_storage_read', key);
    return originalStorageGet.call(this, key);
  };
  const observer = new MutationObserver(() => {
    if (probe.renderedAt === null && probe.expected && document.body?.innerText.includes(probe.expected)) {
      requestAnimationFrame(() => {
        if (probe.renderedAt === null && document.body?.innerText.includes(probe.expected)) {
          probe.renderedAt = performance.now() - probe.startAt;
          probe.record('first_content_rendered');
        }
      });
    }
  });
  observer.observe(document, { childList: true, subtree: true, characterData: true });
})();
