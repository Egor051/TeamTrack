// Exported application, independent browser sessions and real disposable services.
// Run via run-security-integrations.mjs. No hosted data, account or key is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';
import { stopSmokeServer } from './smoke-process-cleanup.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.TASKTRACE_PLAYWRIGHT_MODULE || 'playwright');
const local = getLocalSupabaseStatus();
if (local.kind !== 'tasktrace-isolated-security-test') throw Error('Disposable stack required');
const db = new pg.Client({ connectionString: local.DB_URL });
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, options);
const owner = createClient(local.API_URL, local.ANON_KEY, options);
const foreign = createClient(local.API_URL, local.ANON_KEY, options);
const base = 'http://127.0.0.1:4178', password = 'TemplateBrowserUnique9!';
const out = process.env.TASKTRACE_SECURITY_EVIDENCE || resolve('.expo/security-evidence');
mkdirSync(out, { recursive: true });
const value = async p => { const r = await p; if (r.error) throw r.error; return r.data; };
const rpc = (name, args) => value(owner.rpc(name, args));
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(probe, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await probe()) return; await pause(100); }
  throw Error('Template browser timeout: ' + label);
}
async function login(page, email) {
  await page.goto(base + '/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.getByRole('heading', { name: 'Проекты', exact: true }).waitFor();
  await page.goto(base + '/templates');
  await page.getByRole('heading', { name: 'Глобальные шаблоны', exact: true }).waitFor();
}
async function cache(page) {
  return page.evaluate(async () => {
    const db = await new Promise((ok, no) => { const r = indexedDB.open('tasktrace-local-cache'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    try { return await new Promise((ok, no) => { const r = db.transaction('entries').objectStore('entries').getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); }
    finally { db.close(); }
  });
}
let browser, server;
const checks = [], errors = [];
try {
  await db.connect();
  const users = [];
  for (const [i, client] of [owner, foreign].entries()) {
    const email = `templates-browser-${process.pid}-${i}@test.local`;
    users.push((await value(admin.auth.admin.createUser({ email, password, email_confirm: true }))).user.id);
    await value(client.auth.signInWithPassword({ email, password }));
  }
  await new Promise((ok, no) => { const p = spawn(process.execPath, ['scripts/build-phase6-local-smoke.mjs'], { stdio: 'inherit', windowsHide: true }); p.on('error', no); p.on('exit', c => c === 0 ? ok() : no(Error('Export failed: ' + c))); });
  server = spawn(process.execPath, ['scripts/serve-web.mjs'], { env: { ...process.env, PORT: '4178' }, stdio: 'ignore', windowsHide: true });
  await until(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'server');
  browser = await chromium.launch({ headless: true });
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const routes = []; let dropSocket = false, joins = 0, requests = 0;
  for (const [i, context] of contexts.entries()) {
    await context.route('**/*', route => [base, new URL(local.API_URL).origin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    context.on('page', p => { p.on('pageerror', e => errors.push(e.message)); if (i === 1) p.on('request', r => { if (r.url().includes('/rpc/get_task_template_page')) requests++; }); });
  }
  await contexts[1].routeWebSocket('**/realtime/v1/**', ws => {
    if (dropSocket) { ws.close({ code: 1013, reason: 'isolated reconnect test' }); return; }
    joins++; routes.push(ws); ws.connectToServer();
  });
  const a = await contexts[0].newPage(), b = await contexts[1].newPage();
  await login(a, `templates-browser-${process.pid}-0@test.local`);
  await login(b, `templates-browser-${process.pid}-0@test.local`);
  await until(async () => joins > 0, 'second session socket');
  await a.getByLabel('Название', { exact: true }).fill('Realtime created');
  await a.getByRole('button', { name: 'Создать шаблон', exact: true }).click();
  await b.getByRole('button', { name: 'Раскрыть шаблон Realtime created', exact: true }).waitFor();
  const template = (await db.query('select id from public.task_templates where name=$1', ['Realtime created'])).rows[0].id;
  await a.getByRole('button', { name: 'Раскрыть шаблон Realtime created', exact: true }).click();
  await b.getByRole('button', { name: 'Раскрыть шаблон Realtime created', exact: true }).click();
  await a.getByLabel('Название', { exact: true }).nth(1).fill('Realtime renamed');
  await a.getByRole('button', { name: 'Сохранить шаблон', exact: true }).click();
  await until(async () => await b.getByLabel('Название', { exact: true }).nth(1).inputValue() === 'Realtime renamed', 'rename');
  for (const title of ['First item', 'Second item']) {
    await a.getByLabel('Новый пункт', { exact: true }).fill(title);
    await a.getByRole('button', { name: 'Добавить пункт', exact: true }).click();
    await b.getByText(title === 'First item' ? '1. First item' : '2. Second item', { exact: true }).waitFor();
  }
  await a.getByRole('button', { name: 'Изменить', exact: true }).first().click();
  await a.getByLabel('Название пункта', { exact: true }).fill('Edited item');
  await a.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await b.getByText('1. Edited item', { exact: true }).waitFor();
  await a.getByRole('button', { name: 'Вниз', exact: true }).first().click();
  await b.getByText('2. Edited item', { exact: true }).waitFor();
  await a.getByRole('button', { name: 'Удалить', exact: true }).nth(2).click();
  await a.getByRole('button', { name: 'Удалить пункт', exact: true }).click();
  await until(async () => !(await b.getByText('2. Edited item', { exact: true }).count()), 'item deletion');
  checks.push('independent browser contexts: create/rename template and add/edit/reorder/delete items through UI and real Broadcast');
  // Each browser edits against the same baseline. The second draft survives and
  // cannot overwrite the first until its owner explicitly rebases it.
  await b.getByLabel('Название', { exact: true }).nth(1).fill('Second session draft');
  await a.getByLabel('Название', { exact: true }).nth(1).fill('First session wins');
  await a.getByRole('button', { name: 'Сохранить шаблон', exact: true }).click();
  await b.getByRole('button', { name: 'Продолжить с моим черновиком', exact: true }).waitFor();
  assert.equal(await b.getByLabel('Название', { exact: true }).nth(1).inputValue(), 'Second session draft');
  assert(await b.getByRole('button', { name: 'Сохранить шаблон', exact: true }).isDisabled());
  const stale = await owner.rpc('update_task_template', { p_template_id: template, p_name: 'Lost', p_description: '', p_expected_name: 'Realtime renamed', p_expected_description: '' });
  assert.equal(stale.error?.code, 'PT409');
  await b.getByRole('button', { name: 'Продолжить с моим черновиком', exact: true }).click();
  await b.getByRole('button', { name: 'Сохранить шаблон', exact: true }).click();
  await until(async () => await a.getByLabel('Название', { exact: true }).nth(1).inputValue() === 'Second session draft', 'explicit rebase');
  checks.push('concurrent UI drafts, explicit rebase and actual stale RPC PT409');
  // Disconnect only Realtime. HTTP remains live; rejoin must refresh missed data.
  const oldJoins = joins; dropSocket = true; for (const ws of routes) ws.close({ code: 1012, reason: 'isolated transport loss' });
  await rpc('update_task_template', { p_template_id: template, p_name: 'Missed while disconnected' });
  await pause(700); dropSocket = false;
  await until(async () => joins > oldJoins, 'transport reconnect');
  await until(async () => await b.getByLabel('Название', { exact: true }).nth(1).inputValue() === 'Missed while disconnected', 'reconnect refresh');
  checks.push('Realtime-only loss, missed mutation and authoritative rejoin refresh');
  // Trusted server duplicates; ordinary clients must not inject Broadcast data.
  const before = requests;
  await db.query("do $$begin for n in 1..12 loop perform realtime.send(jsonb_build_object('table','task_templates','operation','UPDATE'),'invalidate','templates',true); end loop; end$$;");
  await pause(1500); const duplicateReadRequests = requests - before;
  assert(duplicateReadRequests <= 4, 'duplicate storm produced excessive template reads: ' + duplicateReadRequests);
  const stable = requests; await pause(1200); assert.equal(requests, stable, 'refresh loop after duplicate burst');
  checks.push('12 duplicate events coalesced, request count bounded and stable afterward');
  // Revoking unrelated membership must not close the authenticated global topic.
  const project = await value(foreign.rpc('create_project', { p_name: 'Permission fixture' }));
  await value(foreign.rpc('add_project_member', { p_project_id: project, p_user_id: users[0], p_role: 'member' }));
  await value(foreign.rpc('remove_project_member', { p_project_id: project, p_user_id: users[0] }));
  await rpc('update_task_template', { p_template_id: template, p_name: 'After membership revoke' });
  await until(async () => await b.getByLabel('Название', { exact: true }).nth(1).inputValue() === 'After membership revoke', 'global access after revoke');
  const hidden = await value(foreign.rpc('create_task_template', { p_name: 'Foreign active library' }));
  await b.getByRole('button', { name: 'Раскрыть шаблон Foreign active library', exact: true }).waitFor();
  assert.equal((await owner.rpc('update_task_template', { p_template_id: hidden, p_name: 'Forbidden' })).error?.code, '42501');
  await value(foreign.rpc('archive_task_template', { p_template_id: hidden }));
  await until(async () => !(await b.getByRole('button', { name: 'Раскрыть шаблон Foreign active library', exact: true }).count()), 'foreign archived template hidden');
  assert.equal(await rpc('get_task_template', { p_template_id: hidden }), null);
  checks.push('membership revoke preserves global library; foreign active read allowed, foreign edit denied, archived foreign content absent');
  await b.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await until(async () => (await cache(b)).some(e => e.key === `template-items:${template}` && e.schema_version === 2), 'versioned complete item cache');
  await contexts[1].setOffline(true);
  await b.reload();
  await b.getByRole('button', { name: 'Раскрыть шаблон After membership revoke', exact: true }).waitFor();
  await rpc('update_task_template', { p_template_id: template, p_name: 'Changed during offline restart' });
  await contexts[1].setOffline(false);
  await b.getByRole('button', { name: 'Раскрыть шаблон Changed during offline restart', exact: true }).waitFor();
  await b.getByRole('button', { name: 'Раскрыть шаблон Changed during offline restart', exact: true }).click();
  await b.getByText('1. Second item', { exact: true }).waitFor();
  const entries = await cache(b), catalog = entries.find(e => e.key === 'templates');
  assert.equal(catalog.schema_version, 2); assert(JSON.parse(catalog.data).some(t => t.id === template && t.name === 'Changed during offline restart'));
  checks.push('offline reload/restart, reconnect and canonical v2 catalog/item caches consistent');
  await a.getByRole('button', { name: 'Удалить', exact: true }).first().click();
  await a.getByRole('button', { name: 'Удалить', exact: true }).last().click();
  await until(async () => !(await b.getByRole('button', { name: 'Свернуть шаблон Changed during offline restart', exact: true }).count()), 'template archive');
  assert.equal(await rpc('get_task_template', { p_template_id: template }), null);
  checks.push('template deletion closes expanded view and removes server-readable content');
  assert.deepEqual(errors, []);
  writeFileSync(resolve(out, 'template-realtime-browser.json'), JSON.stringify({ checks, checks_passed: checks.length, duplicate_read_requests: duplicateReadRequests, browser_errors: errors, real_services: true, independent_contexts: 2 }, null, 2));
  await b.screenshot({ path: resolve(out, 'template-realtime-browser.png') });
  console.log('PASS template Realtime browser: ' + checks.length + ' groups; real Auth/PostgREST/private Broadcast, independent caches, CAS, reconnect and offline restart');
} catch (error) {
  if (browser) for (const [i, context] of browser.contexts().entries()) for (const page of context.pages()) {
    try { writeFileSync(resolve(out, `template-browser-failure-${i}.json`), JSON.stringify({ checks, body: await page.locator('body').innerText(), cache: await cache(page) }, null, 2)); } catch { /* Closing browser. */ }
  }
  throw error;
} finally {
  await browser?.close(); await stopSmokeServer(server);
  for (const c of [admin, owner, foreign]) { await c.removeAllChannels(); c.realtime.disconnect(); }
  await db.end().catch(() => undefined);
}
