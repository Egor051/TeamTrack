import { copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import workboxBuild from 'workbox-build';
import { isAppNavigation } from './pwa-navigation.mjs';

const dist = join(process.cwd(), 'dist');
const required = [
  'index.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'favicon.ico',
];

for (const file of required) await stat(join(dist, file));

// Every exported route uses the same Expo Router bundle. The real pathname is
// read by the browser at boot, so this document can start any protected route.
// Keep it separate from index.html so ordinary online navigation stays network-only.
await copyFile(join(dist, 'index.html'), join(dist, 'offline-shell.html'));

const { count, size, warnings } = await workboxBuild.generateSW({
  globDirectory: dist,
  globPatterns: [
    'offline-shell.html',
    '_expo/static/**/*.{js,css,woff,woff2,ttf,otf,png,jpg,jpeg,svg,webp}',
    'manifest.webmanifest',
    'icons/*.png',
    'favicon.ico',
  ],
  swDest: join(dist, 'sw.js'),
  cleanupOutdatedCaches: true,
  skipWaiting: false,
  clientsClaim: false,
  sourcemap: false,
  runtimeCaching: [{
    // Only known app document routes. Static files, service files, _expo and
    // external API hosts are never intercepted by this navigation fallback.
    urlPattern: isAppNavigation,
    handler: 'NetworkOnly',
    // A mobile connection can stay "online" while its HTML request stalls.
    // Release the existing precached shell without waiting for a TCP failure.
    options: {
      // Workbox 7's generateSW rejects NetworkOnly.networkTimeoutSeconds,
      // although the runtime strategy supports it. Abort via its fetch plugin
      // so the existing PrecacheFallbackPlugin handles the same error path.
      plugins: [{
        requestWillFetch: async ({ request, state }) => {
          const controller = new AbortController();
          const abort = () => controller.abort();
          const timer = setTimeout(abort, 5000);
          request.signal.addEventListener('abort', abort, { once: true });
          if (request.signal.aborted) abort();
          state.dispose = () => {
            clearTimeout(timer);
            request.signal.removeEventListener('abort', abort);
          };
          return new Request(request, { signal: controller.signal });
        },
        fetchDidSucceed: async ({ response, state }) => { state.dispose?.(); return response; },
        fetchDidFail: async ({ state }) => { state.dispose?.(); },
      }],
      precacheFallback: { fallbackURL: '/offline-shell.html' },
    },
  }],
});

if (warnings.length) throw new Error(`Workbox warnings:\n${warnings.join('\n')}`);
if (count < 5) throw new Error(`Incomplete precache: only ${count} files`);
console.log(`Generated dist/sw.js with ${count} precached files (${size} bytes).`);
