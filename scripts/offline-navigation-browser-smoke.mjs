// Real production PWA against local Supabase. Never reads/writes hosted data.
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';
import { closeSmokeBrowser, stopSmokeServer } from './smoke-process-cleanup.mjs';

const root = resolve(import.meta.dirname, '..');
const local = getLocalSupabaseStatus();
if (new URL(local.API_URL).hostname !== '127.0.0.1' || new URL(local.DB_URL).hostname !== '127.0.0.1') throw new Error('Local stack required');
const base = 'http://127.0.0.1:4175';
const session = `offline-account-${Date.now()}`;
const writerSession = `${session}-writer`;
const db = new pg.Client({ connectionString: local.DB_URL });
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const owner = createClient(local.API_URL, local.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const password = 'AccountOffline#123';
const email = `${session}@test.local`;
let server, userId, projectId, archivedProjectId, templateId, originalConfig;
let browserCliReady = false;
let writerStarted = false;
const check = (value, message) => { if (!value) throw new Error(message); };
async function value(promise) { const { data, error } = await promise; if (error) throw error; return data; }
function command(executable, args, env = process.env) {
  const windows = process.platform === 'win32' && ['npm', 'npx'].includes(executable);
  // The browser daemon inherits stdio on Windows. A file, rather than a pipe,
  // lets the CLI exit without waiting for the daemon to close stdout.
  const output = resolve(tmpdir(), `tasktrace-account-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const fd = openSync(output, 'w');
  try {
  const r = spawnSync(windows ? process.env.ComSpec : executable, windows ? ['/d','/s','/c',executable,...args] : args,
    { cwd: root, env, encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: ['ignore',fd,fd] });
  const result = readFileSync(output, 'utf8').trim();
  if (r.error || r.status) throw new Error(`${executable} ${args.slice(0, 3).join(' ')}: ${r.error?.message ?? result ?? r.status}`);
  return result;
  } finally { closeSync(fd); try { unlinkSync(output); } catch { /* daemon can retain its log */ } }
}
function browserIn(targetSession, ...args) {
  if (!browserCliReady) {
    // Resolve/install before any interaction, then use the cached CLI. Repeated
    // npm registry lookups must not interrupt an uncertain checkbox/save click.
    try { command('npx', ['--offline','--yes','agent-browser','--help']); }
    catch (error) {
      if (!/ENOTCACHED|cache mode|offline mode|could not determine executable/i.test(error.message)) throw error;
      command('npx', ['--yes','agent-browser','--help']);
    }
    browserCliReady = true;
  }
  const run = () => command('npx', ['--offline','--yes','agent-browser','--session',targetSession,'--init-script',resolve(root,'scripts/offline-navigation-instrumentation.js'),...args]);
  try { return run(); }
  catch (error) {
    // Match the existing Phase 6 smoke's Windows CLI recovery. Retry only reads
    // and idempotent navigation/settings, never an uncertain click or fill.
    if (/3221226505|ETIMEDOUT/.test(error.message)
      && ['reload','open','get','snapshot','eval','wait','set'].includes(args[0])) return run();
    throw error;
  }
}
const browser = (...args) => browserIn(session, ...args);
const writerBrowser = (...args) => { writerStarted = true; return browserIn(writerSession, ...args); };
function ref(snapshot, text) {
  const match = snapshot.split('\n').find((line) => line.includes(text) && /ref=e\d+/.test(line))?.match(/ref=(e\d+)/);
  if (!match) throw new Error(`Missing control ${text}: ${snapshot}`); return `@${match[1]}`;
}
async function eventually(probe, label, timeout = 45_000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) { try { if (await probe()) return; } catch (e) { last = e; } await new Promise((r) => setTimeout(r, 500)); }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
}
const body = () => browser('get','text','body');
const has = (text) => eventually(() => body().includes(text), text);
async function open(route, text, { readiness = false } = {}) {
  browser('open', base + route); await has(text);
  check(browser('get','url') === base + route, `Route changed on reload: ${route}`);
  if (!readiness) check(!body().includes('Офлайн: '), `Offline readiness indicator leaked to ${route}`);
}
function metadata() {
  return JSON.parse(browser('eval', `(async function(){const db=await new Promise(function(ok,no){const r=indexedDB.open('tasktrace-local-cache');r.onsuccess=function(){ok(r.result)};r.onerror=function(){no(r.error)}});try{return await new Promise(function(ok,no){const r=db.transaction('entries').objectStore('entries').get('${userId}:bootstrap:metadata');r.onsuccess=function(){ok(r.result?JSON.parse(r.result.data):null)};r.onerror=function(){no(r.error)}})}finally{db.close()}})()`));
}
function runtimeSnapshot() {
  return JSON.parse(browser('eval', `(async function(){const db=await new Promise(function(ok,no){const r=indexedDB.open('tasktrace-local-cache');r.onsuccess=function(){ok(r.result)};r.onerror=function(){no(r.error)}});try{return await new Promise(function(ok,no){const r=db.transaction('entries').objectStore('entries').get('${userId}:runtime:offline-capabilities');r.onsuccess=function(){ok(r.result?JSON.parse(r.result.data):null)};r.onerror=function(){no(r.error)}})}finally{db.close()}})()`));
}
function pendingOperations() {
  return JSON.parse(browser('eval', `(async function(){const db=await new Promise(function(ok,no){const r=indexedDB.open('tasktrace-local-cache');r.onsuccess=function(){ok(r.result)};r.onerror=function(){no(r.error)}});try{return await new Promise(function(ok,no){const r=db.transaction('pending_operations').objectStore('pending_operations').index('by_user').getAll('${userId}');r.onsuccess=function(){ok(r.result)};r.onerror=function(){no(r.error)}})}finally{db.close()}})()`));
}
function activeTabTarget() {
  const target = JSON.parse(browser('tab','list','--json')).data?.tabs?.find((tab) => tab.active)?.targetId;
  check(typeof target === 'string', 'Active browser tab is unavailable');
  return target;
}
async function setRuntime(write, sync) {
  await db.query('update private.offline_runtime_config set write_enabled = $1, sync_enabled = $2, updated_at = now()', [write, sync]);
}

async function runPerformance(taskId) {
  const baseline = process.argv.includes('--baseline');
  const report = { baseline, environment: 'production static PWA / local Supabase / headless Chromium', offline: [], degraded: [] };
  const file = resolve(root, `.expo/offline-navigation-${baseline ? 'before' : 'after'}.json`);
  const routes = [
    ['/projects', 'Офлайн основной проект'], [`/projects/${projectId}`, 'Основной этап'],
    [`/projects/${projectId}/tasks/${taskId}`, 'Сохранённый комментарий'],
    [`/projects/${projectId}/members`, 'Офлайн тест'], ['/templates', 'Офлайн шаблон'], ['/profile', 'Офлайн тест'],
    [`/projects/${projectId}/progress`, 'Основной пункт'], [`/projects/${projectId}/tasks/${taskId}/progress`, 'Основной пункт'],
  ];
  const capture = async (route, text, spa = false) => {
    browser('eval', `sessionStorage.setItem('timing:expected', ${JSON.stringify(text)});true`);
    if (spa) browser('eval', `window.__navigationProbe.start(${JSON.stringify(text)});history.pushState(null,'',${JSON.stringify(route)});dispatchEvent(new PopStateEvent('popstate'));true`);
    else browser('open', base + route);
    await has(text);
    await eventually(() => JSON.parse(browser('eval', 'window.__navigationProbe.renderedAt')) !== null, 'render timing');
    const result = JSON.parse(browser('eval', 'window.__navigationProbe'));
    const network = result.events.filter((e) => e.event === 'network_started');
    const row = { route: route.replaceAll(projectId, ':project').replaceAll(taskId, ':task'), ms: Math.round(result.renderedAt), requests: network.length,
      probeRequests: result.events.filter((e) => e.event === 'connectivity_probe_started').length, events: result.events };
    console.log(JSON.stringify({ route: row.route, ms: row.ms, requests: row.requests, rpc: network.map((e) => e.key) }));
    return row;
  };
  browser('set', 'offline', 'on');
  for (const [route, text] of routes) {
    const row = await capture(route, text); report.offline.push(row);
    if (!baseline) { check(row.requests === 0, `Known offline network calls: ${row.route}`); check(row.ms < 1000, `Slow cached render: ${row.route} ${row.ms}ms`); }
  }
  if (!baseline) {
    // Keep the real refresh token, expire only SDK restoration metadata. An
    // offline hard reload must not await the SDK's refresh retry loop.
    const savedExpiry = JSON.parse(browser('eval', "(function(){const key=Object.keys(localStorage).find(function(k){return k.endsWith('-auth-token')});return JSON.parse(localStorage.getItem(key)).expires_at})()"));
    browser('eval', "(function(){const key=Object.keys(localStorage).find(function(k){return k.endsWith('-auth-token')});const value=JSON.parse(localStorage.getItem(key));value.expires_at=1;localStorage.setItem(key,JSON.stringify(value));return true})()");
    report.expiredSession = await capture(...routes[0]);
    check(report.expiredSession.requests === 0 && report.expiredSession.ms < 1000, 'Expired saved session blocked offline startup');
    report.expiredProgress = await capture(...routes[6]);
    check(report.expiredProgress.requests === 0 && report.expiredProgress.ms < 1000, 'Expired saved session blocked offline progress');
    // Do not poison the independent fake-online case with artificial expired
    // metadata and the Auth SDK's refresh failure cooldown from this case.
    browser('eval', `(function(){const key=Object.keys(localStorage).find(function(k){return k.endsWith('-auth-token')});const value=JSON.parse(localStorage.getItem(key));value.expires_at=${savedExpiry};localStorage.setItem(key,JSON.stringify(value));return true})()`);
  }
  browser('set', 'offline', 'off');
  // Real session/preload; only transport is replaced by a controlled 1200ms
  // failure while navigator.onLine stays true. This exposes repeated waits.
  browser('eval', "sessionStorage.setItem('timing:dead','true');true");
  report.degraded.push(await capture(...routes[0]));
  check(JSON.parse(browser('eval', 'navigator.onLine')) === true, 'Fake-online scenario is actually offline');
  for (const [route, text] of routes.slice(1, 3)) {
    const row = await capture(route, text, true); report.degraded.push(row);
    if (!baseline) { check(row.requests === 0, `Degraded route attempted network: ${row.route}`); check(row.ms < 1000, `Slow degraded render: ${row.route}`); }
  }
  writeFileSync(file, JSON.stringify(report, null, 2));
  // A browser online event must probe/revalidate and reopen network reads.
  browser('eval', "sessionStorage.removeItem('timing:dead');dispatchEvent(new Event('online'));true");
  try {
    await eventually(() => JSON.parse(browser('eval', "window.__navigationProbe.events.some(function(e){return e.event==='network_finished' && e.key.startsWith('/rest/v1/')})")), 'successful Data API recovery');
  } catch (error) {
    report.recoveryFailure = JSON.parse(browser('eval', 'window.__navigationProbe'));
    writeFileSync(file, JSON.stringify(report, null, 2));
    throw error;
  }
  report.recovery = await capture(...routes[0], true);
  check(report.recovery.requests > 0, 'Recovery did not restore network reads');
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`Timing report: ${file}`);
}

async function runRequestMeasurements(taskId, itemId) {
  const baseline = process.argv.includes('--baseline');
  const report = { baseline, environment: 'Local Supabase + production PWA, warm Basic cache, Chromium', scenarios: [], storage: [] };
  const start = () => browser('eval', 'window.__navigationProbe.start(null);true');
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await eventually(() => {
      const events = JSON.parse(browser('eval', 'window.__navigationProbe.events'));
      return events.filter((e) => e.event === 'network_started').length
        === events.filter((e) => e.event === 'network_finished' || e.event === 'network_failed').length;
    }, 'settled request window');
  };
  const capture = async (name, action) => {
    start(); await action(); await settle();
    const events = JSON.parse(browser('eval', 'window.__navigationProbe.events'));
    const requests = events.filter((e) => e.event === 'network_started').map((e) => e.key.split('?')[0]);
    const endpoints = Object.fromEntries([...new Set(requests)].sort().map((key) => [key, requests.filter((r) => r === key).length]));
    const row = { name, requests: requests.length, endpoints, probes: events.filter((e) => e.event === 'connectivity_probe_started').length };
    report.scenarios.push(row); console.log(JSON.stringify(row));
  };
  const spa = async (route, text) => {
    browser('eval', `history.pushState(null,'',${JSON.stringify(route)});dispatchEvent(new PopStateEvent('popstate'));true`);
    await has(text);
  };
  const storage = () => JSON.parse(browser('eval', `(async()=>{const db=await new Promise((ok,no)=>{const r=indexedDB.open('tasktrace-local-cache');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});try{const all=await new Promise((ok,no)=>{const r=db.transaction('entries').objectStore('entries').getAll();r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});const rows=all.filter(e=>e.user_id===${JSON.stringify(userId)});const categories={};for(const e of rows){const kind=e.key.startsWith('bootstrap:page:')||e.key.startsWith('bootstrap:batch:')?'bootstrap-pages':e.key.split(':')[0];const v=categories[kind]??={records:0,bytes:0};v.records++;v.bytes+=new TextEncoder().encode(JSON.stringify(e)).length}return{records:rows.length,bytes:rows.reduce((n,e)=>n+new TextEncoder().encode(JSON.stringify(e)).length,0),categories,estimate:await navigator.storage.estimate()}}finally{db.close()}})()`));
  report.storage.push({ name: 'warm-basic', ...storage() });
  await capture('open /projects', async () => { browser('reload'); await has('Офлайн основной проект'); });
  await capture('open project', () => spa(`/projects/${projectId}`, 'Основной этап'));
  await capture('project -> task', () => spa(`/projects/${projectId}/tasks/${taskId}`, 'Сохранённый комментарий'));
  await capture('task -> project', () => spa(`/projects/${projectId}`, 'Основной этап'));
  await capture('realtime one item', async () => { await value(owner.rpc('set_task_item_percentage', { p_task_item_id: itemId, p_percentage: 41 })); });
  await capture('foreground unchanged', async () => { browser('eval', "dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));true"); });
  await spa('/projects', 'Офлайн основной проект'); await settle();
  await capture('manual refresh', async () => { browser('click', ref(browser('snapshot','-i'), 'button "Обновить"')); });
  await capture('offline recovery', async () => { browser('set','offline','on'); await new Promise((resolve) => setTimeout(resolve, 500)); browser('set','offline','off'); await has('Офлайн основной проект'); });
  report.storage.push({ name: 'after-scenarios', ...storage() });
  writeFileSync(resolve(root, `.expo/cache-requests-${baseline ? 'before' : 'after'}.json`), JSON.stringify(report, null, 2));
}
try {
  await db.connect();
  originalConfig = (await db.query('select write_enabled, sync_enabled, updated_at::text as updated_at from private.offline_runtime_config')).rows[0];
  await setRuntime(true, true);
  userId = (await value(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: 'Офлайн тест' } }))).user.id;
  await value(owner.auth.signInWithPassword({ email, password }));
  projectId = await value(owner.rpc('create_project', { p_name: 'Офлайн основной проект' }));
  const taskId = await value(owner.rpc('create_task', { p_project_id: projectId, p_title: 'Основной этап' }));
  const itemId = await value(owner.rpc('create_task_item', { p_task_id: taskId, p_title: 'Основной пункт' }));
  await value(owner.rpc('set_task_item_percentage', { p_task_item_id: itemId, p_percentage: 40 }));
  await value(owner.rpc('set_task_item_comment', { p_task_item_id: itemId, p_comment: 'Сохранённый комментарий' }));
  const archivedItem = await value(owner.rpc('create_task_item', { p_task_id: taskId, p_title: 'Архивный пункт' }));
  await value(owner.rpc('archive_task_item', { p_task_item_id: archivedItem }));
  archivedProjectId = await value(owner.rpc('create_project', { p_name: 'Офлайн архивный проект' }));
  const archivedTask = await value(owner.rpc('create_task', { p_project_id: archivedProjectId, p_title: 'Архивный этап' }));
  await value(owner.rpc('create_task_item', { p_task_id: archivedTask, p_title: 'Архивный чек-лист' }));
  await value(owner.rpc('archive_task', { p_task_id: archivedTask }));
  await value(owner.rpc('archive_project', { p_project_id: archivedProjectId }));
  templateId = await value(owner.rpc('create_task_template', { p_name: 'Офлайн шаблон' }));
  await value(owner.rpc('create_task_template_item', { p_template_id: templateId, p_title: 'Пункт шаблона' }));
  await db.query(`insert into public.notifications(user_id,type,title,body,is_read,read_at,dedupe_key,created_at)
    select $1,'task_item_changed','Офлайн уведомление ' || g,'Сохранённое уведомление',g > 120,
      case when g > 120 then now() else null end,$2 || g,now() - g * interval '1 second' from generate_series(1,240) g`, [userId, session]);
  server = spawn(process.execPath, ['scripts/serve-web.mjs'], { cwd: root, env: { ...process.env, PORT: '4175' }, stdio: 'ignore', windowsHide: true });
  await eventually(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'web server');
  browser('open', base + '/login');
  const login = browser('snapshot','-i');
  browser('fill', ref(login, 'textbox "Email"'), email);
  browser('fill', ref(login, 'textbox "Пароль"'), password);
  browser('click', ref(login, 'button "Войти"'));
  await has('Офлайн: готово');
  check(metadata().scheme === 'basic' && metadata().offline_ready, 'Fresh account is not ready/basic');
  check(body().includes('Синхронизация:'), 'Sync/readiness indicators are not independent');
  browser('screenshot', resolve(root,'.expo/account-offline-basic.png'));
  console.log('PASS automatic basic bootstrap, independent projects indicators and PWA assets');
  await eventually(() => runtimeSnapshot()?.value?.write_enabled === true && runtimeSnapshot()?.value?.sync_enabled === true, 'confirmed runtime capabilities');

  if (process.argv.includes('--requests')) await runRequestMeasurements(taskId, itemId);
  else await runPerformance(taskId);
} catch (error) {
  try { console.error('Failed page:', body()); browser('screenshot', resolve(root, '.expo/account-offline-failure.png')); } catch { /* browser failed */ }
  throw error;
} finally {
  const cleanupErrors = [];
  try { if (writerStarted) closeSmokeBrowser(writerBrowser); } catch (e) { cleanupErrors.push(e); }
  try { if (browserCliReady) closeSmokeBrowser(browser); } catch (e) { cleanupErrors.push(e); }
  try { await stopSmokeServer(server); } catch (e) { cleanupErrors.push(e); }
  if (userId) {
    // The administrative connection was explicitly checked as local above.
    try {
      if (projectId) {
        await value(owner.rpc('archive_project', { p_project_id: projectId }));
        await value(owner.rpc('hard_delete_project', { p_project_id: projectId }));
      }
      if (archivedProjectId) await value(owner.rpc('hard_delete_project', { p_project_id: archivedProjectId }));
      if (templateId) await db.query('delete from public.task_templates where id = $1', [templateId]);
      // Immutable audit/profile FKs intentionally retain the synthetic local
      // identity. Do not bypass application deletion policy for test cleanup.
      console.log('Local project/template fixtures removed; synthetic audit identity retained.');
    } catch (e) { console.warn('Local fixture cleanup:', e.message); }
  }
  if (originalConfig) {
    await db.query('update private.offline_runtime_config set write_enabled = $1, sync_enabled = $2, updated_at = $3',
      [originalConfig.write_enabled, originalConfig.sync_enabled, originalConfig.updated_at]).catch((e) => console.warn('Local config restore:', e.message));
  }
  await db.end().catch(() => undefined);
  await Promise.all([admin.removeAllChannels(), owner.removeAllChannels()]);
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Browser smoke process cleanup failed');
}
