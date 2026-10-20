// Exported PWA + real disposable Auth/PostgREST/Realtime. Run through
// run-security-integrations.mjs; application/hosted data is never modified.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import pg from 'pg';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';
import { stopSmokeServer } from './smoke-process-cleanup.mjs';

const local = getLocalSupabaseStatus();
assert.ok(process.env.TASKTRACE_ISOLATED_CONFIG && local.kind === 'tasktrace-isolated-security-test'
  && /^\/teamtrack_audit_\d+$/.test(new URL(local.DB_URL).pathname)
  && [local.API_URL, local.DB_URL].every(url => new URL(url).hostname === '127.0.0.1'), 'Disposable loopback stack required');
const auth = { persistSession: false, autoRefreshToken: false };
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth });
const owner = createClient(local.API_URL, local.ANON_KEY, { auth });
const db = new pg.Client({ connectionString: local.DB_URL });
const origin = 'http://127.0.0.1:4178';
const evidence = resolve('.expo/connectivity-recovery');
const results = [], errors = [], requests = [];
let browser, server, page, context, mode = 'normal', dropNextMutationResponse = false, dropped = false;
let originalConfig;
const value = async promise => { const result = await promise; if (result.error) throw result.error; return result.data; };
async function until(check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(label);
}
const body = () => page.locator('body').innerText();
const connected = () => until(async () => (await body()).includes('Синхронизация: подключено'), 'Connected status did not return');
async function refresh() {
  const button = page.getByRole('button', { name: 'Обновить', exact: true });
  const checked = page.waitForRequest(request => new URL(request.url()).pathname === '/auth/v1/health');
  await button.click(); await checked;
  // The click can return before React disables the button. Observe rendering
  // before checking completion so the next fault cannot overtake this refresh.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await until(() => button.isEnabled(), 'Refresh remained pending', 60_000);
}
async function pending(userId) {
  return page.evaluate(async user => {
    const db = await new Promise((ok, no) => {
      const request = indexedDB.open('tasktrace-local-cache'); request.onsuccess = () => ok(request.result); request.onerror = () => no(request.error);
    });
    try { return await new Promise((ok, no) => {
      const request = db.transaction('pending_operations').objectStore('pending_operations').index('by_user').getAll(user);
      request.onsuccess = () => ok(request.result); request.onerror = () => no(request.error);
    }); } finally { db.close(); }
  }, userId);
}
function pass(scenario, details = {}) { results.push({ scenario, pass: true, ...details }); console.log('PASS connectivity recovery', JSON.stringify(results.at(-1))); }
try {
  await mkdir(evidence, { recursive: true }); await db.connect();
  originalConfig = (await db.query('select write_enabled, sync_enabled, updated_at from private.offline_runtime_config')).rows[0];
  await db.query('update private.offline_runtime_config set write_enabled=true, sync_enabled=true, updated_at=now()');
  const email = `connectivity-${Date.now()}@test.local`, password = 'ConnectivityFixture#123';
  const { user } = await value(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: 'Connectivity fixture' } }));
  const { session } = await value(owner.auth.signInWithPassword({ email, password }));
  const project = await value(owner.rpc('create_project', { p_name: 'Connectivity recovery project' }));
  const task = await value(owner.rpc('create_task', { p_project_id: project, p_title: 'Connectivity stage' }));
  const item = await value(owner.rpc('create_task_item', { p_task_id: task, p_title: 'Durable connectivity edit' }));
  const build = spawn(process.execPath, ['scripts/build-phase6-local-smoke.mjs'], { stdio: 'inherit', windowsHide: true });
  await new Promise((ok, no) => { build.on('error', no); build.on('exit', code => code === 0 ? ok() : no(new Error('Local export failed'))); });
  server = spawn(process.execPath, ['scripts/serve-web.mjs'], { env: { ...process.env, PORT: '4178' }, stdio: 'ignore', windowsHide: true });
  await until(async () => { try { return (await fetch(origin)).ok; } catch { return false; } }, 'Static server did not start');
  browser = await chromium.launch({ headless: true }); context = await browser.newContext();
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort('internetdisconnected');
    if (url.origin !== local.API_URL) return route.continue();
    const path = url.pathname;
    if (mode === 'data-down' && path.startsWith('/rest/v1/')) return route.fulfill({ status: 503, body: 'Gateway temporarily unavailable' });
    if (mode === 'auth-down' && path === '/auth/v1/health') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"Auth unavailable"}' });
    if (mode === 'query-failure' && path === '/rest/v1/projects' && url.searchParams.get('limit') !== '0') return route.abort('failed');
    if (dropNextMutationResponse && /\/rpc\/apply_task_item_state_operation_v2$/.test(path)) {
      dropNextMutationResponse = false;
      const response = await route.fetch(); assert.equal(response.status(), 200, 'Mutation must commit before losing its response');
      dropped = true; return route.abort('failed');
    }
    return route.continue();
  });
  await context.addInitScript(saved => localStorage.setItem('sb-127-auth-token', JSON.stringify(saved)), session);
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().startsWith(local.API_URL)) requests.push({ path: new URL(request.url()).pathname, method: request.method(), at: Date.now() });
  });
  await page.goto(`${origin}/projects`); await page.getByText('Офлайн: готово', { exact: true }).waitFor({ timeout: 60_000 }); await connected();
  mode = 'query-failure'; await refresh();
  assert.ok(!(await body()).includes('Синхронизация: офлайн'), 'An isolated query must not mark the whole app offline');
  assert.ok(!(await body()).includes('Нет подключения к сети'), 'A cached response must not claim the Internet is disconnected');
  assert.ok((await body()).includes('Connectivity recovery project')); pass('isolated request does not change global connectivity');
  mode = 'normal'; await refresh(); await connected();

  mode = 'data-down'; await refresh();
  assert.ok((await body()).includes('Синхронизация: сервер недоступен')); assert.equal(await page.evaluate(() => navigator.onLine), true);
  const recoveryStart = Date.now(); mode = 'normal'; await connected();
  pass('Data API outage automatically recovers without a network event or reload', { elapsed_ms: Date.now() - recoveryStart });

  mode = 'auth-down'; await refresh(); assert.ok((await body()).includes('Синхронизация: сервис входа недоступен'));
  mode = 'normal'; await new Promise(resolve => setTimeout(resolve, 1100));
  await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await connected();
  pass('Auth service outage is distinct and focus resumes the mounted page');

  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); window.dispatchEvent(new Event('offline')); });
  await until(async () => (await body()).includes('Синхронизация: офлайн'), 'Offline hint did not render');
  await refresh(); await connected(); assert.equal(await page.evaluate(() => navigator.onLine), false);
  await page.evaluate(() => { delete navigator.onLine; window.dispatchEvent(new Event('online')); });
  pass('Refresh verifies services despite a stale negative navigator.onLine');

  const taskUrl = `${origin}/projects/${project}/tasks/${task}`;
  await page.goto(taskUrl); const checkbox = page.getByRole('checkbox', { name: /Durable connectivity edit/ }); await checkbox.waitFor(); await connected();
  await context.setOffline(true); await until(async () => (await body()).includes('Синхронизация: офлайн'), 'Offline status did not render');
  await checkbox.click(); await until(async () => (await pending(user.id)).length === 1, 'Offline edit was not durable');
  const firstOperation = (await pending(user.id))[0].operation_id;
  await page.goto(`${origin}/projects`); await page.getByText('Connectivity recovery project', { exact: true }).waitFor();
  await refresh(); assert.equal((await pending(user.id))[0].operation_id, firstOperation, 'Offline Refresh changed the operation identity');
  await context.setOffline(false); await connected(); await until(async () => (await pending(user.id)).length === 0, 'Offline outbox did not drain');
  assert.equal((await db.query('select percentage from public.task_items where id=$1', [item])).rows[0].percentage, 100);
  assert.equal((await db.query('select count(*)::int as n from private.client_operation_receipts where user_id=$1 and operation_id=$2', [user.id, firstOperation])).rows[0].n, 1);
  pass('offline Refresh retains the outbox and reconnect commits its operation once');

  await page.goto(taskUrl); await checkbox.waitFor(); await connected(); await context.setOffline(true); await checkbox.click();
  await until(async () => (await pending(user.id)).length === 1, 'Second offline edit was not durable');
  const secondOperation = (await pending(user.id))[0].operation_id;
  dropNextMutationResponse = true; await context.setOffline(false); await until(async () => dropped, 'Committed response was not intercepted');
  await page.goto(`${origin}/projects`); await page.getByText('Connectivity recovery project', { exact: true }).waitFor();
  await refresh(); await until(async () => (await pending(user.id)).length === 0, 'Lost response did not reconcile');
  assert.equal((await db.query('select percentage from public.task_items where id=$1', [item])).rows[0].percentage, 0);
  assert.equal((await db.query('select count(*)::int as n from private.client_operation_receipts where user_id=$1 and operation_id=$2', [user.id, secondOperation])).rows[0].n, 1);
  pass('lost committed RPC response replays the same operation without a duplicate mutation');
  assert.deepEqual(errors, []); await page.screenshot({ path: resolve(evidence, 'recovered.png'), fullPage: true });
} catch (error) {
  if (page) await page.screenshot({ path: resolve(evidence, 'failure.png'), fullPage: true }).catch(() => undefined);
  results.push({ pass: false, error: error.message, body: page ? await body().catch(() => '') : '' }); throw error;
} finally {
  await writeFile(resolve(evidence, 'results.json'), JSON.stringify({ results, errors, requests }, null, 2));
  await browser?.close(); await stopSmokeServer(server);
  if (originalConfig) await db.query('update private.offline_runtime_config set write_enabled=$1,sync_enabled=$2,updated_at=$3',
    [originalConfig.write_enabled, originalConfig.sync_enabled, originalConfig.updated_at]);
  await db.end().catch(() => undefined);
}
