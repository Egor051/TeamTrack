import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAppNavigation } from '../scripts/pwa-navigation.mjs';

beforeEach(() => vi.stubGlobal('self', { location: { origin: 'https://tasktrace.test' } }));
afterEach(() => vi.unstubAllGlobals());

const matches = (path, mode = 'navigate', origin = 'https://tasktrace.test') =>
  isAppNavigation({ request: { mode }, url: new URL(path, origin) });

describe('PWA navigation fallback boundary', () => {
  it('covers the root and protected Expo Router paths', () => {
    for (const path of ['/', '/projects', '/projects/00000000-0000-4000-8000-0000000000b1',
      '/projects/00000000-0000-4000-8000-0000000000b1/tasks/00000000-0000-4000-8000-0000000000c1',
      '/login', '/profile']) expect(matches(path)).toBe(true);
  });

  it('never returns HTML for assets, service files, API-like paths or non-navigation requests', () => {
    for (const path of ['/_expo/static/js/web/entry.js', '/sw.js', '/manifest.webmanifest',
      '/icons/icon-192.png', '/favicon.ico', '/api/projects', '/rest/v1/projects',
      '/auth/v1/token', '/projects/a.json', '/_sitemap']) expect(matches(path)).toBe(false);
    expect(matches('/projects', 'fetch')).toBe(false);
    expect(matches('/projects', 'navigate', 'https://external.test')).toBe(false);
  });
});
