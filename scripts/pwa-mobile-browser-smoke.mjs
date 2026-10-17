// Exercise real exported HTML, JavaScript and Workbox in separate browser
// engines. Device descriptors emulate browsers; they are not physical devices.
// All HTTP traffic outside this temporary loopback server is blocked.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import { isAppNavigation } from './pwa-navigation.mjs';

const require = createRequire(import.meta.url);
const { chromium, webkit, devices } = require(process.env.TASKTRACE_PLAYWRIGHT_MODULE || 'playwright');
const root = resolve('dist');
await stat(resolve(root, 'sw.js'));
const evidence = resolve('.expo/mobile-diagnostics');
await mkdir(evidence, { recursive: true });
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const held = new Set();
let stallNavigation = false, failNavigation = false, version = 1;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const appRoute = isAppNavigation({ request: { mode: 'navigate' }, url: new URL(req.url, origin) });
  if (appRoute && stallNavigation) { held.add(res); res.on('close', () => held.delete(res)); return; }
  if (appRoute && failNavigation) { req.socket.destroy(); return; }
  const path = resolve(root, `.${url.pathname}`);
  if (path !== root && !path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  let file = path;
  try { if (!(await stat(file)).isFile()) throw new Error('Not a file'); }
  catch { if (!appRoute) { res.writeHead(404).end(); return; } file = resolve(root, 'index.html'); }
  try {
    let body = await readFile(file);
    if (url.pathname === '/sw.js') body = Buffer.concat([Buffer.from(`// browser regression version ${version}\n`), body]);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(500).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
globalThis.self = { location: { origin } };
const results = [];
try {
  for (const [name, engine, device] of [
    ['android-chromium', chromium, devices['Pixel 7']],
    ['ios-webkit', webkit, devices['iPhone 13']],
  ]) {
    let browser;
    const errors = [];
    try {
      version = 1; stallNavigation = false; failNavigation = false;
      browser = await engine.launch({ headless: true });
      const context = await browser.newContext({ ...device });
      await context.route('**/*', (route) => new URL(route.request().url()).origin === origin
        ? route.continue() : route.abort('internetdisconnected'));
      context.on('page', (page) => page.on('pageerror', (e) => errors.push(e.message)));
      let page = await context.newPage();
      const login = () => page.getByRole('button', { name: 'Войти', exact: true });
      await page.goto(origin);
      await login().waitFor();
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await page.reload();
      await login().waitFor();
      assert.equal(await page.evaluate(() => navigator.serviceWorker.controller?.state), 'activated');
      await page.goto(`${origin}/projects/fixture/tasks/fixture`);
      await login().waitFor();

      // Actual connection failure at the server, avoiding OS/browser-specific
      // offline emulation. The API remains isolated by the route above.
      failNavigation = true;
      await page.reload({ timeout: 8000 });
      await login().waitFor();
      failNavigation = false;

      // Cold PWA/tab open with Wi-Fi still reporting online but no HTML reply.
      await page.close(); stallNavigation = true;
      page = await context.newPage();
      const started = Date.now();
      await page.goto(`${origin}/projects/fixture/tasks/fixture`, { waitUntil: 'load', timeout: 8000 });
      await login().waitFor({ timeout: 1000 });
      const navigationRecoveryMs = Date.now() - started;
      assert.ok(navigationRecoveryMs < 7500, 'Cached shell did not release stalled navigation');
      assert.equal(await page.evaluate(() => navigator.onLine), true);
      for (const response of held) response.destroy();
      stallNavigation = false;

      // A waiting update stays waiting until the existing user action. Apply
      // it once, reload once, and keep cached navigation working afterwards.
      let navigations = 0;
      // Expo Router also emits frame events for pushState/replaceState. Count
      // document requests so client-side redirects are not mistaken for reloads.
      page.on('request', (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++;
      });
      version = 2;
      await page.evaluate(async () => { const registration = await navigator.serviceWorker.ready; await registration.update(); });
      await page.getByText('Доступна новая версия TaskTrace.', { exact: true }).waitFor({ timeout: 8000 });
      assert.equal(navigations, 0, 'An update reloaded before user approval');
      await page.getByRole('button', { name: 'Обновить', exact: true }).click();
      await page.waitForFunction(() => !document.body.textContent.includes('Доступна новая версия TaskTrace.'));
      await login().waitFor();
      assert.equal(navigations, 1, 'Applying a waiting update must reload once');
      assert.equal(await page.evaluate(async () => !!(await navigator.serviceWorker.ready).waiting), false);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: resolve(evidence, `${name}-pwa.png`), fullPage: true });
      const result = { name, pass: true, navigationRecoveryMs, updateReloads: navigations, errors };
      results.push(result); console.log(JSON.stringify(result));
      await context.close();
    } catch (error) {
      const result = { name, pass: false, error: error.message, errors };
      results.push(result); console.error(JSON.stringify(result));
    } finally { for (const response of held) response.destroy(); await browser?.close(); }
  }
} finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
await writeFile(resolve(evidence, 'pwa-browser-results.json'), JSON.stringify(results, null, 2));
assert.ok(results.length === 2 && results.every((result) => result.pass), 'PWA browser regression failed');
