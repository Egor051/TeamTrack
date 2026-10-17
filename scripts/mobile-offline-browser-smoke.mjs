// Real local Auth/PostgREST/Realtime and exported PWA in two browser engines.
// Requires run-security-integrations.mjs; never runs against hosted/app data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';
import { stopSmokeServer } from './smoke-process-cleanup.mjs';

const local = getLocalSupabaseStatus();
if (!process.env.TASKTRACE_ISOLATED_CONFIG || local.kind !== 'tasktrace-isolated-security-test'
  || !/^\/teamtrack_audit_\d+$/.test(new URL(local.DB_URL).pathname)
  || [local.API_URL, local.DB_URL].some(url => new URL(url).hostname !== '127.0.0.1'))
  throw new Error('A disposable loopback security test stack is required');
const require = createRequire(import.meta.url);
const { chromium, webkit, devices } = require(process.env.TASKTRACE_PLAYWRIGHT_MODULE || 'playwright');
const engines = (process.env.TASKTRACE_MOBILE_BROWSER_ENGINES || 'chromium,webkit').split(',');
assert.ok(engines.length && engines.every(name => ['chromium', 'webkit'].includes(name)), 'Unknown browser engine');
const auth = { persistSession: false, autoRefreshToken: false };
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth });
const client = createClient(local.API_URL, local.ANON_KEY, { auth });
const db = new pg.Client({ connectionString: local.DB_URL });
const base = 'http://127.0.0.1:4177';
const evidence = resolve('.expo/mobile-diagnostics');
const results = [];
let server;
const value = async promise => { const r = await promise; if (r.error) throw r.error; return r.data; };
async function until(probe, message, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await probe()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(message);
}
async function metadata(page, userId) {
  return page.evaluate(async user => {
    const db = await new Promise((ok, no) => {
      const request = indexedDB.open('tasktrace-local-cache');
      request.onsuccess = () => ok(request.result); request.onerror = () => no(request.error);
    });
    try { return await new Promise((ok, no) => {
      const request = db.transaction('entries').objectStore('entries').get(`${user}:bootstrap:metadata`);
      request.onsuccess = () => ok(request.result ? JSON.parse(request.result.data) : null);
      request.onerror = () => no(request.error);
    }); } finally { db.close(); }
  }, userId);
}
try {
  await mkdir(evidence, { recursive: true });
  const build = spawn(process.execPath, ['scripts/build-phase6-local-smoke.mjs'], { stdio: 'inherit', windowsHide: true });
  await new Promise((ok, no) => { build.on('error', no); build.on('exit', code => code === 0 ? ok() : no(new Error('Local web build failed'))); });
  server = spawn(process.execPath, ['scripts/serve-web.mjs'], { env: { ...process.env, PORT: '4177' }, stdio: 'ignore', windowsHide: true });
  await until(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'Static server did not start');
  await db.connect();
  const email = `mobile-offline-${Date.now()}@test.local`, password = 'MobileOffline#123';
  const { user } = await value(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: 'Mobile offline fixture' } }));
  const { session } = await value(client.auth.signInWithPassword({ email, password }));
  const project = await value(client.rpc('create_project', { p_name: 'Mobile offline project' }));
  const task = await value(client.rpc('create_task', { p_project_id: project, p_title: 'Mobile offline stage' }));
  await value(client.rpc('create_task_item', { p_task_id: task, p_title: 'Mobile offline checklist' }));
  await db.query(`insert into public.notifications(user_id,type,title,body,is_read,read_at,dedupe_key,created_at)
    select $1,'task_item_changed','Mobile notice '||g,'Offline fixture',g>120,
      case when g>120 then now() else null end,$2||g,now()-g*interval '1 second'
    from generate_series(1,240) g`, [user.id, email]);
  for (const [name, engine, device] of [
    ['android-chromium', chromium, devices['Pixel 7']], ['ios-webkit', webkit, devices['iPhone 13']],
  ]) {
    if (!engines.includes(engine.name())) continue;
    const browser = await engine.launch({ headless: true });
    const errors = [], apiRequests = [];
    try {
      const context = await browser.newContext({ ...device });
      await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
        ? route.continue() : route.abort('internetdisconnected'));
      await context.addInitScript(session => localStorage.setItem('sb-127-auth-token', JSON.stringify(session)), session);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (/\/rest\/v1\/|\/auth\/v1\//.test(request.url())) apiRequests.push(new URL(request.url()).pathname); });
      const body = () => page.locator('body').innerText();
      await page.goto(`${base}/projects`);
      await page.getByText('Офлайн: готово', { exact: true }).waitFor({ timeout: 60000 });
      await page.goto(`${base}/profile`);
      await page.getByRole('radio', { name: /Расширенная/ }).click();
      await until(async () => { const m = await metadata(page, user.id); return m?.scheme === 'extended' && m.extended_ready && !m.lease; }, 'Extended snapshot was not committed');
      await page.reload();
      await page.getByRole('radio', { name: /Расширенная/ }).waitFor();
      await until(async () => {
        const m = await metadata(page, user.id);
        return m?.scheme === 'extended' && m.extended_ready && !m.lease;
      }, 'Extended snapshot did not survive reload');
      await context.setOffline(true);
      const before = apiRequests.length;
      await page.goto(`${base}/projects/${project}/tasks/${task}/history`);
      await page.getByText(/Показана сохранённая история за последние 90 дней/).waitFor();
      assert.equal(await page.evaluate(() => navigator.onLine), false);
      assert.ok((await body()).includes('Mobile offline checklist'));
      await page.goto(`${base}/notifications`);
      await page.getByText(/Показаны сохранённые уведомления/).waitFor();
      for (let n = 0; n < 8 && !(await body()).includes('Mobile notice 200'); n++)
        await page.getByRole('button', { name: 'Загрузить ещё', exact: true }).click();
      assert.ok((await body()).includes('Mobile notice 200'));
      assert.equal((await metadata(page, user.id)).datasets.notifications.count, 220);
      await page.goto(`${base}/profile`);
      await page.getByRole('radio', { name: /Базовая/ }).click();
      await until(async () => { const m = await metadata(page, user.id); return m?.scheme === 'basic' && m.basic_ready; }, 'Offline Basic switch failed');
      await page.goto(`${base}/projects`);
      await page.getByText('Офлайн: готово', { exact: true }).waitFor();
      await page.reload();
      await page.getByText('Mobile offline project', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => navigator.onLine), false);
      const offlineApiRequests = apiRequests.length - before;
      assert.equal(offlineApiRequests, 0, 'Offline routes attempted API requests');
      await context.setOffline(false);
      await until(async () => !(await body()).includes('Нет подключения к сети. Показаны сохранённые данные.'), 'Mounted route did not recover');
      assert.equal(page.url(), `${base}/projects`);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: resolve(evidence, `${name}-offline-recovery.png`), fullPage: true });
      results.push({ name, pass: true, offlineApiRequests, history: true, notificationCount: 220, basicSwitch: true, reload: true, reconnect: true, errors });
      console.log('PASS mobile offline', JSON.stringify(results.at(-1)));
      await context.close();
    } catch (error) {
      results.push({ name, pass: false, error: error.message, errors });
      throw error;
    } finally {
      await writeFile(resolve(evidence, 'mobile-offline-results.json'), JSON.stringify(results, null, 2));
      await browser.close();
    }
  }
  await writeFile(resolve(evidence, 'mobile-offline-results.json'), JSON.stringify(results, null, 2));
} finally { await stopSmokeServer(server); await db.end().catch(() => undefined); }
