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
  const run = () => command('npx', ['--offline','--yes','agent-browser','--session',targetSession,...args]);
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
async function stormSoak(itemId) {
  const tabs = [activeTabTarget()];
  const counts = () => JSON.parse(browser('eval', `performance.getEntriesByType('resource').reduce(function(n,e){if(e.name.includes('/rpc/get_offline_account_manifest'))n.manifest++;if(e.name.includes('/rpc/get_offline_account_page'))n.page++;return n},{manifest:0,page:0})`));
  const reset = () => browser('eval', 'performance.setResourceTimingBufferSize(10000);performance.clearResourceTimings();true');
  const idle = async (label) => {
    const start = Date.now();
    while (Date.now() - start < 300_000) {
      await new Promise((r) => setTimeout(r, Math.min(30_000, 300_000 - (Date.now() - start))));
      console.log(`Idle ${label}: ${Math.round((Date.now() - start) / 1000)}s`);
    }
    let manifest = 0, page = 0;
    for (const tab of tabs) { browser('tab', tab); const c = counts(); manifest += c.manifest; page += c.page; }
    check(page === 0 && manifest <= 4, `Idle ${label} requests exceeded bound: ${manifest} manifests/${page} pages`);
    return { duration_ms: Date.now() - start, tabs: tabs.length, manifest, page };
  };
  const burstOnly = process.argv.includes('--storm-burst');
  reset(); const single = burstOnly ? null : await idle('single-tab');
  for (let i = 0; i < 2; i++) {
    browser('tab', 'new'); tabs.push(activeTabTarget());
    browser('open', base + '/projects'); await has('Офлайн: готово');
  }
  for (const tab of tabs) { browser('tab', tab); reset(); }
  const multi = burstOnly ? null : await idle('three-tabs');
  if (!burstOnly) {
    console.log('PASS bootstrap idle windows:', JSON.stringify({ single, multi }));
    writeFileSync(resolve(root, '.expo/bootstrap-browser-idle.json'), JSON.stringify({ single, multi }, null, 2));
  }
  // Opening peers queues their initial connected revalidation. Drain it before
  // measuring the mutation burst so startup requests cannot inflate its count.
  await eventually(() => { const m = metadata(); return m?.status === 'ready' && Date.now() - (m.last_attempt_at ?? 0) > 31_000; }, 'settled tab startup', 100_000);
  for (const tab of tabs) { browser('tab', tab); reset(); }
  // Item changes use project/task topics. Account bootstrap's user topic gets
  // notification invalidations. Keep unread/read membership unchanged.
  const changed = await db.query(`update public.notifications set body = body || ' burst'
    where id in (select id from public.notifications where user_id=$1 order by created_at desc,id desc limit 50)`, [userId]);
  check(changed.rowCount === 50, 'Realtime burst did not update 50 fixture rows');
  const finished = Date.now();
  try { await eventually(() => Date.parse(metadata()?.last_successful_sync_at ?? '') >= finished, 'Realtime burst refresh', 60_000); }
  catch (error) { console.error('Burst metadata:', JSON.stringify(metadata())); console.error('Burst counts:', JSON.stringify(counts())); throw error; }
  await new Promise((r) => setTimeout(r, 2500));
  let manifest = 0, page = 0;
  for (const tab of tabs) { browser('tab', tab); const c = counts(); manifest += c.manifest; page += c.page; }
  check(manifest === 2 && page <= 3, `50 mutations were not coalesced: ${manifest} manifests/${page} pages`);
  const report = { single, multi, burst: { mutations: 50, manifest, page }, snapshot_at: metadata()?.manifest?.snapshot_at };
  writeFileSync(resolve(root, `.expo/bootstrap-browser-${burstOnly ? 'burst' : 'soak'}.json`), JSON.stringify(report, null, 2));
  console.log('PASS bootstrap storm soak:', JSON.stringify(report));
  await controlledBrowserMutation(tabs, itemId);
  browser('tab', tabs[0]);
}
async function controlledBrowserMutation(tabs, itemId) {
  const task = (await db.query('select task_id from public.task_items where id=$1', [itemId])).rows[0].task_id;
  // Make the upcoming manifest contain a changed items batch, ensuring this
  // run fetches a page instead of reusing a previously confirmed batch.
  await value(owner.rpc('set_task_item_comment', { p_task_item_id: itemId, p_comment: 'Concurrent bootstrap setup' }));
  writerBrowser('open', base + '/login');
  const login = writerBrowser('snapshot', '-i');
  writerBrowser('fill', ref(login, 'textbox "Email"'), email);
  writerBrowser('fill', ref(login, 'textbox "Пароль"'), password);
  writerBrowser('click', ref(login, 'button "Войти"'));
  await eventually(() => writerBrowser('get', 'text', 'body').includes('Офлайн: готово'), 'separate session preload');
  writerBrowser('open', `${base}/projects/${projectId}/tasks/${task}`);
  await eventually(() => writerBrowser('get', 'text', 'body').includes('40% выполнено'), 'separate session checklist');
  browser('tab', tabs[0]);
  await eventually(() => { const m = metadata(); return m?.status === 'ready' && Date.now() - (m.last_attempt_at ?? 0) > 31_000; }, 'settled main startup', 100_000);
  // Delay an unmodified real manifest Response. No response, revision, session
  // or permission is fabricated. Other-tab UI performs the actual server write.
  const arm = `(function(){const original=window.fetch;const probe=window.__bootstrapProbe={armed:true,waiting:false,records:[],release:null,restore:function(){window.fetch=original;delete window.__bootstrapProbe}};window.fetch=async function(input,init){const url=String(input.url||input);const response=await original.call(this,input,init);if(url.includes('/rpc/get_offline_account_')){const args=JSON.parse(init.body||'{}');const record={rpc:url.split('/').pop(),dataset:args.p_dataset,offset:args.p_offset,status:response.status};if(!response.ok){const error=await response.clone().json();record.code=error.code;record.details=error.details}probe.records.push(record);if(url.includes('/rpc/get_offline_account_manifest')&&probe.armed&&!args.p_snapshot_at){probe.armed=false;probe.waiting=true;await new Promise(function(ok){probe.release=function(){probe.waiting=false;ok()}})}}return response};return true})()`;
  for (const tab of tabs) { browser('tab', tab); browser('eval', arm); if (tab !== tabs[0]) browser('eval', 'window.__bootstrapProbe.armed=false;true'); }
  browser('tab', tabs[0]); browser('eval', "window.dispatchEvent(new Event('online'));true");
  const ownerTab = tabs[0];
  await eventually(() => browser('eval', 'Boolean(window.__bootstrapProbe.waiting)') === 'true', 'held real manifest', 60_000);
  writerBrowser('click', ref(writerBrowser('snapshot', '-i'), 'checkbox "Основной пункт'));
  await eventually(async () => (await db.query('select percentage from public.task_items where id=$1', [itemId])).rows[0].percentage === 100, 'other-tab server mutation');
  const mutated = Date.now(); browser('tab', ownerTab); browser('eval', 'window.__bootstrapProbe.release();true');
  await eventually(() => metadata()?.offline_ready && Date.parse(metadata()?.last_successful_sync_at ?? '') >= mutated, 'browser conflict recovery', 60_000);
  const records = [];
  for (const tab of tabs) { browser('tab', tab); records.push(...JSON.parse(browser('eval', 'window.__bootstrapProbe.records'))); browser('eval', 'window.__bootstrapProbe.restore();true'); }
  const conflicts = records.filter((r) => r.code === 'PT409');
  check(conflicts.length === 1 && conflicts[0].dataset === 'items', `Expected one items conflict: ${JSON.stringify(records)}`);
  check(records.filter((r) => r.rpc === 'get_offline_account_manifest').length === 3, 'Browser retry did not consume exactly one restart');
  writeFileSync(resolve(root, '.expo/bootstrap-browser-mutation.json'), JSON.stringify({ ownerTab, mutator: 'separate browser session', records }, null, 2));
  console.log('PASS other-tab mutation during bootstrap: one PT409, three manifests, ready');
  await value(owner.rpc('set_task_item_percentage', { p_task_item_id: itemId, p_percentage: 40 }));
  await value(owner.rpc('set_task_item_comment', { p_task_item_id: itemId, p_comment: 'Сохранённый комментарий' }));
  const restored = Date.now();
  await eventually(() => writerBrowser('get', 'text', 'body').includes('40% выполнено'), 'restored fixture');
  closeSmokeBrowser(writerBrowser); writerStarted = false;
  browser('tab', ownerTab); browser('eval', "window.dispatchEvent(new Event('online'));true");
  await eventually(() => metadata()?.offline_ready && Date.parse(metadata()?.last_successful_sync_at ?? '') >= restored, 'restored bootstrap fixture', 60_000);
}
async function lifecycleRegressions(taskId) {
  const routeIs = (route) => eventually(() => browser('get', 'url') === base + route, `route ${route}`);
  await open('/projects', 'Офлайн: готово', { readiness: true });
  browser('reload'); await has('Офлайн: готово');
  for (const breadcrumb of [false, true]) {
    browser('click', ref(browser('snapshot', '-i'), 'Открыть проект Офлайн основной проект'));
    await routeIs(`/projects/${projectId}`);
    browser('click', ref(browser('snapshot', '-i'), 'Основной этап'));
    await routeIs(`/projects/${projectId}/tasks/${taskId}`);
    browser('click', ref(browser('snapshot', '-i'), breadcrumb ? 'link "Офлайн основной проект"' : 'К проекту'));
    await routeIs(`/projects/${projectId}`);
    browser('back'); await routeIs('/projects');
  }
  // Direct stage entry still has a usable parent fallback.
  await open(`/projects/${projectId}/tasks/${taskId}`, 'Основной пункт');
  browser('click', ref(browser('snapshot', '-i'), 'К проекту')); await routeIs(`/projects/${projectId}`);
  await open('/projects', 'Офлайн: готово', { readiness: true });
  console.log('PASS navigation button/breadcrumb → project → first browser back, direct links and reload');
  for (const [route, text] of [
    ['/projects', 'Офлайн основной проект'], [`/projects/${projectId}`, 'Основной этап'],
    [`/projects/${projectId}/tasks/${taskId}`, 'Основной пункт'],
  ]) {
    browser('set', 'offline', 'on'); await open(route, text, { readiness: route === '/projects' });
    await has('Нет подключения к сети. Показаны сохранённые данные.');
    browser('set', 'offline', 'off');
    await eventually(() => !body().includes('Нет подключения к сети. Показаны сохранённые данные.'), `mounted route recovery ${route}`);
    check(browser('get', 'url') === base + route, 'Recovery navigated or reloaded the route');
  }
  console.log('PASS three Offline → Online cycles, cached projects/project/stage, mounted route recovery without reload');

  await open('/projects', 'Офлайн: готово', { readiness: true });
  await eventually(() => !metadata()?.lease, 'bootstrap lease released');
  browser('set', 'offline', 'on');
  browser('eval', `(async function(){const db=await new Promise(function(ok,no){const r=indexedDB.open('tasktrace-local-cache');r.onsuccess=function(){ok(r.result)};r.onerror=function(){no(r.error)}});try{await new Promise(function(ok,no){const tx=db.transaction('entries','readwrite');tx.objectStore('entries').delete('${userId}:bootstrap:metadata');tx.oncomplete=function(){ok()};tx.onerror=function(){no(tx.error)}})}finally{db.close()}return true})()`);
  check(metadata() === null, 'Preparation metadata was not cleared before offline start');
  browser('reload'); await has('Офлайн: ожидание сети');
  check(metadata()?.status === 'offline_waiting', 'Offline preparation did not settle');
  // Hold one manifest response. Refresh must join healthy live work until its
  // deadline, then recover the incomplete cache; a late response stays fenced.
  browser('eval', `window.__held=false;window.__fetch=window.fetch;window.fetch=function(input,init){if(!window.__held&&String(input).includes('/rpc/get_offline_account_manifest')){window.__held=true;return new Promise(function(ok,no){window.__fetch(input,init).then(function(response){window.__late=function(){ok(response)}},no)})}return window.__fetch(input,init)};true`);
  browser('set', 'offline', 'off');
  await eventually(() => browser('eval', 'window.__held===true') === 'true', 'automatic resumed attempt');
  check(/Офлайн: (подготовка|обновление)/.test(body()), 'Automatic recovery did not start preparation');
  check(!['running','updating','recovering','syncing'].includes(metadata()?.status), 'Runtime preparation was persisted');
  browser('eval', 'window.fetch=window.__fetch;true');
  check(!body().includes('Повторить'), 'A separate preparation Retry is still visible');
  browser('click', ref(browser('snapshot', '-i'), 'button "Обновить"'));
  await has('Офлайн: готово'); await eventually(() => !metadata()?.lease, 'new retry finished');
  const ready = metadata().completed_at;
  browser('eval', 'if(window.__late)window.__late();true');
  check(metadata().status === 'ready' && metadata().completed_at === ready, 'Late old response overwrote the retry result');
  console.log('PASS automatic recovery, Refresh joins live work through deadline, late response cannot overwrite ready');

  await eventually(() => !metadata()?.lease && !body().includes('Синхронизация: в процессе'), 'idle ready state');
  browser('eval', `window.__refreshRequests=[];window.__refreshFetch=window.fetch;window.fetch=function(input,init){window.__refreshRequests.push(String(input.url||input));return window.__refreshFetch(input,init)};true`);
  browser('click', ref(browser('snapshot', '-i'), 'button "Обновить"'));
  await eventually(() => browser('eval', `Array.from(document.querySelectorAll('[role="button"]')).some(function(el){return el.textContent==='Обновить'&&el.getAttribute('aria-busy')!=='true'&&el.getAttribute('aria-disabled')!=='true'})`) === 'true', 'fresh ready Refresh completed');
  const refreshRequests = JSON.parse(browser('eval', 'window.__refreshRequests'));
  browser('eval', 'window.fetch=window.__refreshFetch;true');
  check(refreshRequests.some((url) => /\/rest\/v1\/projects\?/.test(url)), 'Refresh did not fetch current projects');
  check(!refreshRequests.some((url) => /\/rpc\/(get_offline_account_manifest|get_offline_account_page|apply_task_item_(?:state|percentage|comment)_operation)/.test(url)), `Fresh-ready Refresh performed unnecessary background work: ${JSON.stringify(refreshRequests)}`);
  check(metadata().completed_at === ready && !metadata().lease, 'Fresh-ready Refresh changed the preparation certificate');
  browser('screenshot', resolve(root, '.expo/manual-refresh-projects.png'));
  console.log('PASS fresh-ready Refresh fetches overview, skips account preload/mutations, retains readiness certificate');
  browser('eval', `window.__falseSync=[];window.__statusObserver=new MutationObserver(function(){if(document.body.innerText.includes('Синхронизация: в процессе'))window.__falseSync.push(Date.now())});window.__statusObserver.observe(document.body,{subtree:true,childList:true,characterData:true});window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));true`);
  const first = activeTabTarget(); browser('tab', 'new', base + '/projects'); await has('Офлайн: готово');
  const peer = activeTabTarget();
  const inventory = JSON.parse(browser('tab', 'list', '--json')).data.tabs;
  check(inventory.some((tab) => tab.targetId !== first), `Second tab missing: ${JSON.stringify(inventory)}`);
  browser('tab', first);
  await eventually(() => !metadata()?.lease, 'tab switch maintenance');
  const falseSync = JSON.parse(browser('eval', 'window.__falseSync'));
  check(falseSync.length === 0, `Focus/tab switch advertised an empty sync: ${JSON.stringify(falseSync)}`);
  browser('eval', 'window.__statusObserver.disconnect();true');
  // Retire the peer app before the single-tab offline fixture. An online peer
  // correctly drains the shared outbox even while the original tab is offline.
  // Navigating away avoids Windows CLI errors after closing individual tabs.
  browser('tab', peer); browser('open', 'about:blank'); browser('tab', first);
  check(browser('get', 'url') === base + '/projects', 'Tab switch lost the projects page');
  console.log('PASS ready + focus/visibility/tab switching without false syncing');
}
async function schedulerRegressions() {
  browser('eval', `window.__scheduler={requests:[],active:0,peak:0};window.__schedulerFetch=window.fetch;window.fetch=async function(input,init){const url=String(input.url||input);const p=window.__scheduler;if(!url.includes('/rest/v1/')&&!url.includes('/auth/v1/'))return window.__schedulerFetch(input,init);p.requests.push({url,args:JSON.parse(init?.body||'{}')});p.peak=Math.max(p.peak,++p.active);try{return await window.__schedulerFetch(input,init)}finally{p.active--}};true`);
  const geometry = () => JSON.parse(browser('eval', `(function(){const leaves=Array.from(document.querySelectorAll('*')).filter(e=>!e.children.length);const s=leaves.find(e=>e.textContent.startsWith('Синхронизация:'));const o=leaves.find(e=>e.textContent.startsWith('Офлайн:'));const b=Array.from(document.querySelectorAll('[role="button"]')).find(e=>e.textContent==='Обновить');let block=s;while(block&&!block.contains(o))block=block.parentElement;const sr=s.getBoundingClientRect(),or=o.getBoundingClientRect(),br=b.getBoundingClientRect(),r=block.getBoundingClientRect();return {stacked:or.top>sr.top,aligned:Math.abs(sr.left-or.left)<2,centered:Math.abs((r.top+r.height/2)-(br.top+br.height/2))<2,width:r.width,height:r.height,overflow:document.documentElement.scrollWidth>innerWidth}})()`));
  const desktop = geometry();
  check(desktop.stacked && desktop.aligned && desktop.centered && !desktop.overflow, `Desktop status layout: ${JSON.stringify(desktop)}`);
  browser('screenshot', resolve(root, '.expo/scheduler-projects-desktop.png'));
  browser('set', 'viewport', '390', '844');
  const mobile = geometry(); check(mobile.stacked && mobile.aligned && !mobile.overflow, `Mobile status layout: ${JSON.stringify(mobile)}`);
  browser('screenshot', resolve(root, '.expo/scheduler-projects-mobile.png'));
  browser('set', 'viewport', '1365', '900');
  browser('eval', 'window.__scheduler.requests=[];true');
  await new Promise((resolve) => setTimeout(resolve, 45_000));
  const idle = JSON.parse(browser('eval', 'window.__scheduler.requests'));
  check(idle.length === 0, `Ready foreground ticks made HTTP requests: ${JSON.stringify(idle)}`);
  const started = Date.now();
  const damaged = `${userId}:bootstrap:batch:items:${metadata().datasets.items.revision}:0`;
  browser('eval', `(async function(){const db=await new Promise(ok=>{const r=indexedDB.open('tasktrace-local-cache');r.onsuccess=()=>ok(r.result)});try{await new Promise((ok,no)=>{const tx=db.transaction('entries','readwrite');tx.objectStore('entries').delete(${JSON.stringify(damaged)});tx.oncomplete=ok;tx.onerror=()=>no(tx.error)})}finally{db.close()}return true})()`);
  await eventually(() => metadata()?.basic_ready && !metadata()?.lease && Date.parse(metadata().last_successful_sync_at) >= started, 'automatic missing-page recovery', 45_000);
  await has('Офлайн: готово');
  const recovery = JSON.parse(browser('eval', 'window.__scheduler.requests'));
  const pages = recovery.filter(r => r.url.includes('/rpc/get_offline_account_page'));
  check(pages.length === 1 && pages[0].args.p_dataset === 'items' && pages[0].args.p_offset === 0, `Recovery downloaded unrelated pages: ${JSON.stringify(recovery)}`);
  const restored = geometry();
  check(restored.width === desktop.width && restored.height === desktop.height, 'Readiness recovery changed the status block size');
  browser('eval', 'window.fetch=window.__schedulerFetch;true');
  writeFileSync(resolve(root, '.expo/scheduler-browser.json'), JSON.stringify({ desktop, mobile, idle_seconds: 45, idle_requests: idle.length, recovered_pages: pages.map(p => p.args) }, null, 2));
  console.log('PASS 20s scheduler idle without HTTP, automatic targeted missing-page recovery, stable desktop/390px layout');
}
try {
  console.log('Building production PWA with WRITE=true, SYNC=true against local Supabase...');
  // process env overrides .env; no file or feature-flag changes.
  // The bundler has its own process lifecycle; the 60s browser CLI deadline
  // must not kill a cold export or leave its Metro child running on Windows.
  const build = spawn(process.execPath, ['scripts/build-phase6-local-smoke.mjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
  await new Promise((ok, no) => { build.once('error', no); build.once('exit', (code) => code === 0 ? ok() : no(new Error(`Web build failed: ${code}`))); });
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
  if (process.argv.includes('--scheduler-only')) {
    await schedulerRegressions();
  } else {
  await lifecycleRegressions(taskId);
  await schedulerRegressions();
  if (process.argv.includes('--storm-soak') || process.argv.includes('--storm-burst')) await stormSoak(itemId);

  // None of these routes was opened before switching offline.
  browser('set','offline','on');
  for (const [route, text] of [
    ['/projects','Офлайн основной проект'], [`/projects/${projectId}`,'Основной этап'],
    [`/projects/${archivedProjectId}`,'Офлайн архивный проект'], [`/projects/${projectId}/members`,'Офлайн тест'],
    [`/projects/${projectId}/tasks/${taskId}`,'Сохранённый комментарий'], [`/projects/${archivedProjectId}/tasks/${archivedTask}`,'Архивный чек-лист'],
    [`/projects/${projectId}/progress`,'Основной пункт'], [`/projects/${projectId}/tasks/${taskId}/progress`,'Основной пункт'],
    ['/profile','Офлайн тест'], ['/templates','Офлайн шаблон'],
  ]) {
    await open(route, text, { readiness: route === '/projects' });
    console.log(`PASS offline direct reload ${route.replace(projectId, ':project').replace(taskId, ':task')}`);
  }
  const templates = browser('snapshot','-i');
  browser('click', ref(templates, 'Офлайн шаблон')); await has('Пункт шаблона');
  await open(`/projects/${projectId}/tasks/new`, 'Новый этап');
  await has('Из шаблона');
  browser('click', ref(browser('snapshot','-i'), 'Из шаблона'));
  await has('Выберите шаблон');
  browser('click', ref(browser('snapshot','-i'), 'Выбор шаблона этапа'));
  browser('click', ref(browser('snapshot','-i'), 'menuitem "Офлайн шаблон'));
  await has('Пункт шаблона');
  console.log('PASS cached templates and contents in the new-task form offline');
  await open(`/projects/${projectId}/tasks/${taskId}`, 'Основной пункт');
  const checklist = browser('snapshot','-i');
  browser('click', ref(checklist, 'Архив')); await has('Архивный пункт');
  console.log('PASS cached template expansion and archived checklist tab');

  // Age the real persisted confirmation, then discard all JS memory by loading
  // the route offline. No config value, session or permission is fabricated.
  browser('eval', `(async function(){const db=await new Promise(function(ok){const r=indexedDB.open('tasktrace-local-cache');r.onsuccess=function(){ok(r.result)}});try{await new Promise(function(ok,no){const tx=db.transaction('entries','readwrite');const s=tx.objectStore('entries');const key='${userId}:runtime:offline-capabilities';const r=s.get(key);r.onsuccess=function(){const e=r.result;const v=JSON.parse(e.data);v.fetched_at=Date.now()-61000;e.data=JSON.stringify(v);s.put(e,key)};tx.oncomplete=function(){ok(true)};tx.onerror=function(){no(tx.error)}})}finally{db.close()}return true})()`);
  await open(`/projects/${projectId}/tasks/${taskId}`, 'Основной пункт');
  check(Date.now() - runtimeSnapshot().fetched_at > 60_000, 'Snapshot did not expire before reload');
  browser('click', ref(browser('snapshot','-i'), 'checkbox "Основной пункт'));
  await has('Ожидает синхронизации');
  await eventually(() => pendingOperations().length === 1, 'checkbox outbox');
  browser('click', ref(browser('snapshot','-i'), 'Открыть детали пункта Основной пункт'));
  browser('fill', ref(browser('snapshot','-i'), 'textbox "Прогресс, от 1 до 100%"'), '65');
  browser('click', ref(browser('snapshot','-i'), 'Сохранить прогресс'));
  await has('65% выполнено');
  browser('click', ref(browser('snapshot','-i'), 'Изменить комментарий'));
  browser('fill', ref(browser('snapshot','-i'), 'textbox "Комментарий к пункту"'), 'Комментарий после офлайн reload');
  browser('click', ref(browser('snapshot','-i'), 'Сохранить комментарий'));
  await has('Комментарий после офлайн reload');
  const queued = pendingOperations();
  check(JSON.stringify(queued.map((row) => row.type)) === JSON.stringify(['set_task_item_state','set_task_item_percentage','set_task_item_comment']), 'Three supported mutations did not enter the outbox');
  browser('screenshot', resolve(root,'.expo/account-offline-writes-reload.png'));
  browser('reload'); await has('Комментарий после офлайн reload'); await has('65% выполнено');
  check(pendingOperations().length === 3, 'Offline reload lost pending data');
  console.log('PASS expired runtime snapshot + offline hard reload + checkbox/percentage/comment + durable UI/outbox');

  browser('set','offline','off');
  await eventually(() => pendingOperations().length === 0, 'reconnect ACK and outbox cleanup');
  const confirmed = (await db.query('select percentage, is_completed, comment from public.task_items where id = $1', [itemId])).rows[0];
  check(confirmed.percentage === 65 && confirmed.is_completed === false && confirmed.comment === 'Комментарий после офлайн reload', 'Server did not retain all edits');
  const receipts = (await db.query('select count(*)::int as count from private.client_operation_receipts where user_id = $1 and operation_id = any($2::uuid[])', [userId, queued.map((row) => row.operation_id)])).rows[0].count;
  check(receipts === 3, 'Missing server acknowledgements');
  browser('reload'); await has('Комментарий после офлайн reload'); await has('65% выполнено');
  console.log('PASS reconnect revalidation, three server receipts, outbox cleared and final online reload');

  browser('set','offline','on'); browser('reload'); await has('Основной пункт');
  browser('click', ref(browser('snapshot','-i'), 'checkbox "Основной пункт'));
  await eventually(() => pendingOperations().length === 1, 'operation before disable');
  const retainedId = pendingOperations()[0].operation_id;
  await setRuntime(false, false);
  browser('set','offline','off');
  // A second real tab revalidates and publishes through the existing status
  // channel. The original tab must read its false snapshot before another edit.
  const mainTab = activeTabTarget();
  browser('tab','new');
  const revalidationTab = activeTabTarget();
  check(revalidationTab !== mainTab, 'Second tab was not created');
  await open(`/projects/${projectId}/tasks/${taskId}`, 'Основной пункт');
  await eventually(() => runtimeSnapshot()?.value?.write_enabled === false && runtimeSnapshot()?.value?.sync_enabled === false, 'server disable persisted in another tab');
  browser('tab',mainTab); browser('set','offline','on');
  browser('click', ref(browser('snapshot','-i'), 'checkbox "Основной пункт'));
  await eventually(() => !body().includes('Сохраняем…'), 'disabled mutation finished');
  check(pendingOperations().length === 1 && pendingOperations()[0].operation_id === retainedId, 'Disable added/deleted a pending operation');
  check(body().includes('Операция не выполнена.'), 'Disabled write did not report an error');
  console.log('PASS cross-tab server disable blocks new writes and retains the pending operation');
  await setRuntime(true, true); browser('set','offline','off'); browser('reload');
  await eventually(() => pendingOperations().length === 0, 'retained operation sync after re-enable');
  // Retire the peer before the controlled single-owner interruption. Closing
  // the entire isolated session in finally still handles its browser resources.
  browser('tab', revalidationTab); browser('open', 'about:blank'); browser('tab', mainTab);

  browser('set','offline','off');
  await open('/profile', 'Офлайн-режим');
  const profileBody = body(); check(profileBody.indexOf('Оформление') < profileBody.indexOf('Офлайн-режим'), 'Profile section order');
  const profile = browser('snapshot','-i');
  check(profile.split('\n').some((line) => line.includes('radio "Базовая') && line.includes('checked')), 'Basic is not selected by default');
  browser('eval', `window.__94Fetch=window.fetch;window.__94Held=false;window.fetch=async function(input,init){const url=String(input.url||input);const args=init&&typeof init.body==='string'?JSON.parse(init.body):{};if(!window.__94Held&&url.includes('/rpc/get_offline_account_manifest')&&args.p_scheme==='extended'&&args.p_snapshot_at){window.__94Held=true;const response=await window.__94Fetch(input,init);await new Promise(function(ok){window.__94Late=ok});return response}return window.__94Fetch(input,init)};true`);
  browser('click', ref(profile, 'radio "Расширенная'));
  await eventually(() => browser('eval', 'window.__94Held===true') === 'true' && metadata()?.progress === 94, 'Extended final verification at 94%');
  check(metadata().basic_ready && !metadata().extended_ready, 'Basic/Extended readiness merged during preparation');
  check(!['running','updating'].includes(metadata().status), 'Extended runtime operation persisted');
  browser('set', 'offline', 'on'); await eventually(() => !metadata()?.lease, 'interrupted Extended preparation settled');
  browser('eval', 'window.fetch=window.__94Fetch;true'); browser('set', 'offline', 'off');
  browser('eval', `for(let i=0;i<20;i++){window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));window.dispatchEvent(new Event('pageshow'));document.dispatchEvent(new Event('visibilitychange'))}true`);
  await eventually(() => metadata()?.scheme === 'extended' && metadata()?.extended_ready && !metadata()?.lease, '94% interruption → reconnect → Extended ready', 60_000);
  const extendedCompleted = metadata().completed_at;
  browser('eval', 'if(window.__94Late)window.__94Late();true');
  check(metadata().completed_at === extendedCompleted && metadata().status === 'ready' && metadata().progress === 100,
    'Late 94% verification overwrote successful reconnect');
  console.log('PASS Extended 94% interruption → network loss → coalesced reconnect → ready; late response ignored');
  browser('reload'); await has('Офлайн-режим');
  check(browser('snapshot','-i').split('\n').some((line) => line.includes('radio "Расширенная') && line.includes('checked')), 'Scheme did not persist');
  browser('screenshot', resolve(root,'.expo/account-offline-profile.png'));
  console.log('PASS profile choice placement, basic default, extended switch and persisted setting');
  browser('set','offline','on');
  await open(`/projects/${projectId}/tasks/${taskId}/history`, 'Показана сохранённая история за последние 90 дней');
  await open('/notifications','Показаны сохранённые уведомления');
  const notices = browser('snapshot','-i'); browser('click', ref(notices, 'Загрузить ещё')); await has('Офлайн уведомление 200');
  check(metadata().datasets.notifications.count === 220, 'Notifications were not all unread plus latest 100 read');
  console.log('PASS extended history and bounded notifications pagination offline');
  await open('/profile','Офлайн-режим');
  browser('click', ref(browser('snapshot','-i'), 'radio "Базовая'));
  await eventually(() => metadata().scheme === 'basic' && metadata().offline_ready, 'extended → basic readiness');
  await open('/projects','Офлайн: готово', { readiness: true });
  console.log('PASS extended → basic readiness offline');
  browser('set','offline','off');
  const errors = browser('errors'); check(!errors || /No errors|\[\]/i.test(errors), `Browser errors: ${errors}`);
  const consoleLog = browser('console');
  writeFileSync(resolve(root, '.expo/account-offline-console.log'), consoleLog);
  check(!/unhandled.*rejection|uncaught|maximum update depth|cannot update a component|state update on an unmounted|indexeddb.*(?:exception|quotaexceeded)/i.test(consoleLog), `Browser console regression: ${consoleLog}`);
  }
  console.log('Account offline browser smoke passed');
} catch (error) {
  try { console.error('Failed page:', body()); console.error('Failed metadata:', JSON.stringify(metadata())); browser('screenshot', resolve(root, '.expo/account-offline-failure.png')); } catch { /* browser failed */ }
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
