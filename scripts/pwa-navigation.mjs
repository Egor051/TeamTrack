// Workbox serializes this function into the generated Service Worker. Keep it
// self-contained: imported variables would not exist inside the worker.
export function isAppNavigation({ request, url }) {
  return request.mode === 'navigate'
    && url.origin === self.location.origin
    && /^\/(?:|projects(?:\/[^/.]+)*|login|register|forgot-password|reset-password|profile|templates|notifications)\/?$/.test(url.pathname);
}
