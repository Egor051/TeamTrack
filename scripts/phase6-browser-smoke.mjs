// End-to-end Phase 6 smoke against a local Supabase stack and a production web export.
// Requires Docker/local Supabase and `npx agent-browser` (Chromium).
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';

const root = resolve(import.meta.dirname, '..');
const local = getLocalSupabaseStatus();
for (const raw of [local.API_URL, local.DB_URL]) {
  const url = new URL(raw);
  if (url.hostname !== '127.0.0.1') throw new Error('Phase 6 browser smoke requires local Supabase');
}
if (new URL(local.API_URL).port !== '55431') throw new Error('Unexpected local Supabase API port');
const db = new pg.Client({ connectionString: local.DB_URL });
const base = 'http://127.0.0.1:4174';
const session = `phase6-smoke-${Date.now()}`;
const memberSession = `${session}-member`;
const uxOnly = process.argv.includes('--ux-only');
const swPath = resolve(root, 'dist/sw.js');
let server;
let originalSw;
let browserStarted = false;
let memberBrowserStarted = false;
let originalConfig;

function command(executable, args, { quiet = false } = {}) {
  const wrapNpx = process.platform === 'win32' && executable === 'npx';
  const commandName = wrapNpx ? (process.env.ComSpec ?? 'cmd.exe') : executable;
  const commandArgs = wrapNpx ? ['/d', '/s', '/c', executable, ...args] : args;
  const outputPath = quiet ? resolve(tmpdir(), `tasktrace-browser-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`) : null;
  const outputFd = outputPath ? openSync(outputPath, 'w') : null;
  try {
    const result = spawnSync(commandName, commandArgs, { cwd: root, encoding: 'utf8', timeout: 60_000,
      stdio: outputFd === null ? 'inherit' : ['ignore', outputFd, outputFd] });
    if (result.error) throw result.error;
    const output = outputPath ? readFileSync(outputPath, 'utf8').trim() : '';
    if (result.status !== 0) throw new Error(`${executable} ${args.slice(0, 3).join(' ')} failed: ${output || result.status}`);
    return output;
  } finally {
    if (outputFd !== null) closeSync(outputFd);
    if (outputPath) { try { unlinkSync(outputPath); } catch { /* daemon may still hold the file */ } }
  }
}
function browser(...args) {
  browserStarted = true;
  return browserCommand(session, args);
}
function memberBrowser(...args) {
  memberBrowserStarted = true;
  return browserCommand(memberSession, args);
}
function browserCommand(name, args) {
  const run = () => command('npx', ['--yes', 'agent-browser', '--session', name, ...args], { quiet: true });
  try { return run(); }
  catch (error) {
    // The Windows CLI occasionally exits before sending a read/navigation
    // command to its daemon. Never retry a click/fill whose effect is uncertain.
    if (/3221226505|ETIMEDOUT/.test(error.message)
      && ['reload', 'open', 'get', 'snapshot', 'eval', 'wait', 'set', 'tab'].includes(args[0]))
      return run();
    throw error;
  }
}
function ref(snapshot, name) {
  const line = snapshot.split('\n').find((row) => row.includes(name) && /ref=e\d+/.test(row));
  const match = line?.match(/ref=(e\d+)/);
  if (!match) throw new Error(`Browser control missing: ${name}\n${snapshot}`);
  return `@${match[1]}`;
}
function check(value, message) { if (!value) throw new Error(message); }
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function eventually(probe, description, timeout = 25_000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try { const value = await probe(); if (value) return value; }
    catch (error) { last = error; }
    await sleep(400);
  }
  throw new Error(`${description} timed out${last ? `: ${last.message}` : ''}`);
}
async function setConfig(write, sync) {
  await db.query('update private.offline_runtime_config set write_enabled = $1, sync_enabled = $2, updated_at = now()', [write, sync]);
}
async function percentage(itemId) {
  const result = await db.query('select percentage from public.task_items where id = $1', [itemId]);
  return result.rows[0]?.percentage;
}
async function receiptCount(email) {
  const result = await db.query(`select count(*)::int as count from private.client_operation_receipts r
    join auth.users u on u.id = r.user_id where u.email = $1`, [email]);
  return result.rows[0].count;
}
async function bodyHas(text) { return browser('get', 'text', 'body').includes(text); }
async function bodyEventually(text) {
  let lastBody = '';
  try {
    return await eventually(() => {
      lastBody = browser('get', 'text', 'body');
      return lastBody.includes(text);
    }, `body text ${text}`);
  } catch (error) {
    throw new Error(`${error.message}\nLast body: ${lastBody.slice(-1800)}`);
  }
}
async function remoteChange(email, itemId, value) {
  const client = await signedClient(email);
  const result = await client.rpc('set_task_item_percentage', { p_task_item_id: itemId, p_percentage: value });
  if (result.error) throw result.error;
}
async function signedClient(email) {
  const client = createClient(local.API_URL, local.ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const login = await client.auth.signInWithPassword({ email, password: 'LocalPhase5#123' });
  if (login.error) throw login.error;
  return client;
}
async function openTask(fixture) {
  const url = `${base}/projects/${fixture.projectId}/tasks/${fixture.taskId}`;
  browser('open', url);
  await bodyEventually('Оконные блоки установлены');
  check(browser('get', 'url') === url, 'Direct task URL was not preserved');
  return url;
}
function clickCheckbox() {
  const snapshot = browser('snapshot', '-i');
  browser('click', ref(snapshot, 'checkbox "Оконные блоки установлены'));
}

try {
  await db.connect();
  originalConfig = (await db.query('select write_enabled, sync_enabled, updated_at::text as updated_at from private.offline_runtime_config')).rows[0];
  await setConfig(true, true);
  console.log('Building production web export against local Supabase...');
  command(process.execPath, ['scripts/build-phase6-local-smoke.mjs']);
  const fixture = JSON.parse(command(process.execPath, ['scripts/phase5-browser-smoke.mjs', 'setup'], { quiet: true }));
  server = spawn(process.execPath, ['scripts/serve-web.mjs'], { cwd: root,
    env: { ...process.env, PORT: '4174' }, stdio: 'ignore', windowsHide: true });
  await eventually(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'production web server');

  browser('open', `${base}/login`);
  const login = browser('snapshot', '-i');
  browser('fill', ref(login, 'textbox "Email"'), fixture.aEmail);
  browser('fill', ref(login, 'textbox "Пароль"'), fixture.password);
  browser('click', ref(login, 'button "Войти"'));
  await bodyEventually('Проекты');
  const taskUrl = await openTask(fixture);
  await bodyEventually('Синхронизация: подключено');
  check(!await bodyHas('Проверка синхронизации'), 'Conflict-store loading blocked the checklist');
  check(!await bodyHas('Проверяем синхронизацию'), 'Floating sync banner is still rendered');
  for (const route of [taskUrl + '/progress', taskUrl + '/history', `${base}/projects/${fixture.projectId}/progress`]) {
    browser('open', route);
    await bodyEventually('Синхронизация: подключено');
  }
  await openTask(fixture);
  browser('screenshot', resolve(root, '.expo/sync-ux-online.png'));
  console.log('PASS one compact indicator on task, task progress, history and project progress');

  clickCheckbox();
  await eventually(async () => await percentage(fixture.itemId) === 100 && await bodyHas('Синхронизация: подключено'),
    'local-first online edit');
  console.log('PASS local-first online edit');

  browser('set', 'offline', 'on');
  await bodyEventually('Синхронизация: офлайн');
  clickCheckbox();
  await bodyEventually('Синхронизация: офлайн · 1 несинхр.');
  clickCheckbox();
  await bodyEventually('Синхронизация: офлайн · 2 несинхр.');
  check(!await bodyHas('Обнаружен конфликт синхронизации'), 'Offline edits opened a false conflict');
  browser('reload');
  check(browser('get', 'url') === taskUrl, 'Offline F5 lost the task URL');
  await bodyEventually('Синхронизация: офлайн · 2 несинхр.');
  // Keep eval on one line: the Windows npx wrapper otherwise truncates it at the first newline.
  check(browser('eval', 'window.__syncUxStates = []; window.__syncUxObserver = new MutationObserver(function() { window.__syncUxStates.push(document.body.innerText); }); window.__syncUxObserver.observe(document.body, { subtree: true, childList: true, characterData: true }); true') === 'true',
    'Could not attach the sync-state observer');
  browser('set', 'offline', 'off');
  await eventually(async () => await percentage(fixture.itemId) === 100 && await bodyHas('Синхронизация: подключено'),
    'offline edit reconciliation', 40_000);
  const observedSync = browser('eval', 'window.__syncUxStates.some(function(text) { return text.includes("Синхронизация: в процессе"); })');
  check(observedSync === 'true', `Reconnect never displayed the active sync pass (${observedSync}); observed: ${browser('eval',
    'JSON.stringify(window.__syncUxStates.map(function(text) { return text.match(/Синхронизация: [^\\n]+/g); }))')}`);
  console.log('PASS offline edit, F5, reconnect, status');

  browser('reload'); // Refresh runtime capability before entering offline mode.
  await bodyEventually('Оконные блоки установлены');
  browser('wait', '1800');
  browser('set', 'offline', 'on');
  clickCheckbox();
  await bodyEventually('Ожидает синхронизации');
  await remoteChange(fixture.bEmail, fixture.itemId, 65);
  browser('set', 'offline', 'off');
  await bodyEventually('Обнаружен конфликт синхронизации');
  await bodyEventually('Синхронизация: конфликт');
  browser('press', 'Escape');
  check(await bodyHas('Обнаружен конфликт синхронизации'), 'Escape dismissed the real conflict');
  check(browser('eval', 'Boolean(document.querySelector("[inert]"))') === 'true', 'Underlying app is keyboard-accessible');
  browser('reload');
  check(browser('get', 'url') === taskUrl, 'Conflict F5 lost the task URL');
  const conflict = browser('snapshot', '-i');
  browser('click', ref(conflict, 'button "Оставить серверное"'));
  await eventually(async () => await percentage(fixture.itemId) === 65 && await bodyHas('Синхронизация: подключено')
    && !await bodyHas('Обнаружен конфликт синхронизации'),
    'conflict resolution');
  console.log('PASS conflict persistence and server resolution');

  if (!uxOnly) {
    await setConfig(false, true);
    browser('reload');
    await bodyEventually('Оконные блоки установлены');
    browser('set', 'offline', 'on');
    clickCheckbox();
    check(!await bodyHas('Ожидает синхронизации'), 'Kill switch allowed a new offline operation');
    browser('set', 'offline', 'off');
    check(await percentage(fixture.itemId) === 65, 'Kill switch changed the server item');
    await setConfig(true, true);
    console.log('PASS remote write kill switch');

    browser('reload');
    await bodyEventually('Оконные блоки установлены');
    await bodyEventually('Синхронизация: подключено');
    browser('wait', '1800');
    const beforeReceipts = await receiptCount(fixture.aEmail);
    browser('set', 'offline', 'on');
    clickCheckbox();
    await bodyEventually('Ожидает синхронизации');
    browser('tab', 'new');
    browser('open', taskUrl);
    await bodyEventually('Ожидает синхронизации');
    browser('set', 'offline', 'off');
    await eventually(async () => await percentage(fixture.itemId) === 100 && await receiptCount(fixture.aEmail) === beforeReceipts + 1,
      'cross-tab single application', 40_000);
    await bodyEventually('Синхронизация: подключено');
    console.log('PASS multi-tab queue and one receipt');

    // The remote capability has a 60-second TTL. Browser CLI calls can exceed
    // that interval on Windows, so refresh it before this offline-only probe.
    let queuedForUpdate = false;
    for (let attempt = 0; attempt < 3 && !queuedForUpdate; attempt += 1) {
      browser('reload');
      await bodyEventually('Оконные блоки установлены');
      await bodyEventually('Синхронизация: подключено');
      browser('set', 'offline', 'on');
      clickCheckbox();
      try {
        await eventually(() => bodyHas('Ожидает синхронизации'), 'offline pending operation', 8_000);
        queuedForUpdate = true;
      } catch (error) {
        browser('set', 'offline', 'off');
        if (attempt === 2) throw error;
      }
    }
    await setConfig(false, false);
    browser('set', 'offline', 'off');
    await bodyEventually('Синхронизация: ожидает');
    browser('reload');
    await bodyEventually('Ожидает синхронизации');
    await eventually(() => browser('eval', 'Boolean(navigator.serviceWorker.controller)') === 'true',
      'service-worker control');
    browser('wait', '800');
    originalSw = await readFile(swPath);
    await writeFile(swPath, Buffer.concat([originalSw, Buffer.from(`\n// phase6-smoke-${Date.now()}\n`)]));
    browser('eval', 'navigator.serviceWorker.ready.then(function(reg){return reg.update()})');
    await bodyEventually('Доступна новая версия TaskTrace.');
    const update = browser('snapshot', '-i');
    browser('click', ref(update, 'button "Обновить"'));
    await eventually(() => browser('get', 'url') === taskUrl && bodyHas('Ожидает синхронизации'), 'SW update preserves pending operation');
    await setConfig(true, true);
    browser('reload');
    await eventually(async () => await percentage(fixture.itemId) === 0 && await bodyHas('Синхронизация: подключено'),
      'pending operation after SW update', 40_000);
    console.log('PASS service-worker update with pending operation');
  }

  memberBrowser('open', `${base}/login`);
  const memberLogin = memberBrowser('snapshot', '-i');
  memberBrowser('fill', ref(memberLogin, 'textbox "Email"'), fixture.bEmail);
  memberBrowser('fill', ref(memberLogin, 'textbox "Пароль"'), fixture.password);
  memberBrowser('click', ref(memberLogin, 'button "Войти"'));
  await eventually(() => memberBrowser('get', 'text', 'body').includes('Проекты'), 'member login');
  memberBrowser('open', taskUrl);
  await eventually(() => memberBrowser('get', 'text', 'body').includes('Оконные блоки установлены'), 'member task');
  memberBrowser('wait', '1800');
  memberBrowser('set', 'offline', 'on');
  memberBrowser('click', ref(memberBrowser('snapshot', '-i'), 'checkbox "Оконные блоки установлены'));
  await eventually(() => memberBrowser('get', 'text', 'body').includes('Ожидает синхронизации'), 'member local operation');
  const owner = await signedClient(fixture.aEmail);
  const member = await db.query('select id from auth.users where email = $1', [fixture.bEmail]);
  const memberId = member.rows[0].id;
  const revoked = await owner.rpc('remove_project_member', { p_project_id: fixture.projectId, p_user_id: memberId });
  if (revoked.error) throw revoked.error;
  memberBrowser('set', 'offline', 'off');
  await eventually(() => memberBrowser('get', 'text', 'body').includes('Синхронизация: ошибка'),
    'deterministic failed operation', 40_000);
  memberBrowser('reload');
  await eventually(() => memberBrowser('get', 'text', 'body').includes('Синхронизация: ошибка'),
    'failed operation after F5');
  const restored = await owner.rpc('add_project_member', { p_project_id: fixture.projectId, p_user_id: memberId, p_role: 'member' });
  if (restored.error) throw restored.error;
  memberBrowser('click', ref(memberBrowser('snapshot', '-i'), 'button "Синхронизация: ошибка'));
  check(memberBrowser('get', 'text', 'body').includes('Отменить локальное изменение'), 'Failed discard action is missing');
  check(!memberBrowser('get', 'text', 'body').includes('Обнаружен конфликт синхронизации'), 'Failed operation opened a false conflict');
  if (uxOnly) {
    memberBrowser('set', 'viewport', '390', '844');
    check(memberBrowser('eval', 'Array.from(document.querySelectorAll(\'[role="button"]\')).filter(function(el) { return ["Повторить", "Отменить локальное изменение"].includes(el.textContent); }).every(function(el) { var rect = el.getBoundingClientRect(); return rect.left >= 0 && rect.right <= window.innerWidth; })') === 'true',
      'Failed actions overflow the narrow viewport');
    memberBrowser('screenshot', resolve(root, '.expo/sync-ux-failed.png'));
  }
  memberBrowser('click', ref(memberBrowser('snapshot', '-i'), 'button "Повторить"'));
  await eventually(async () => await percentage(fixture.itemId) === 100
    && memberBrowser('get', 'text', 'body').includes('Синхронизация: подключено'), 'failed operation retry', 40_000);
  memberBrowser('open', taskUrl);
  let restoredBody = '';
  try {
    await eventually(() => {
      restoredBody = memberBrowser('get', 'text', 'body');
      return restoredBody.includes('Оконные блоки установлены');
    }, 'checklist access after membership restoration');
  } catch (error) {
    throw new Error(`${error.message}\nURL: ${memberBrowser('get', 'url')}\nLast body: ${restoredBody.slice(-1800)}`);
  }
  console.log('PASS failed operation persistence and explicit retry');
  if (uxOnly) {
    console.log('Owner page errors:', browser('errors'));
    console.log('Member page errors:', memberBrowser('errors'));
  }

  console.log('Phase 6 production browser smoke PASS');
} finally {
  if (originalSw) await writeFile(swPath, originalSw);
  if (browserStarted) {
    try { browser('set', 'offline', 'off'); } catch { /* browser may have closed */ }
    try { browser('close'); } catch { /* browser may have closed */ }
  }
  if (memberBrowserStarted) {
    try { memberBrowser('set', 'offline', 'off'); } catch { /* browser may have closed */ }
    try { memberBrowser('close'); } catch { /* browser may have closed */ }
  }
  server?.kill();
  if (originalConfig) {
    try { await db.query('update private.offline_runtime_config set write_enabled = $1, sync_enabled = $2, updated_at = $3',
      [originalConfig.write_enabled, originalConfig.sync_enabled, originalConfig.updated_at]); } catch { /* local DB may have stopped */ }
  }
  await db.end().catch(() => undefined);
}
