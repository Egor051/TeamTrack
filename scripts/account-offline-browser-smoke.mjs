// Real production PWA against local Supabase. Never reads/writes hosted data.
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';

const root = resolve(import.meta.dirname, '..');
const local = getLocalSupabaseStatus();
if (new URL(local.API_URL).hostname !== '127.0.0.1' || new URL(local.DB_URL).hostname !== '127.0.0.1') throw new Error('Local stack required');
const base = 'http://127.0.0.1:4175';
const session = `offline-account-${Date.now()}`;
const db = new pg.Client({ connectionString: local.DB_URL });
const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const owner = createClient(local.API_URL, local.ANON_KEY, { auth: { persistSession: false } });
const password = 'AccountOffline#123';
const email = `${session}@test.local`;
let server, userId, projectId, archivedProjectId, templateId;
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
function browser(...args) { return command('npx', ['--yes','agent-browser','--session',session,...args]); }
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
try {
  console.log('Building production PWA with existing mutation flags OFF...');
  // process env overrides .env; no file or feature-flag changes.
  command('npm', ['run','build:web'], { ...process.env, EXPO_PUBLIC_SUPABASE_URL: local.API_URL,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: local.ANON_KEY, EXPO_PUBLIC_OFFLINE_WRITE_ENABLED: 'false', EXPO_PUBLIC_OFFLINE_SYNC_ENABLED: 'false' });
  await db.connect();
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

  browser('set','offline','off');
  await open('/profile', 'Офлайн-режим');
  const profileBody = body(); check(profileBody.indexOf('Оформление') < profileBody.indexOf('Офлайн-режим'), 'Profile section order');
  const profile = browser('snapshot','-i');
  check(profile.split('\n').some((line) => line.includes('radio "Базовая') && line.includes('checked')), 'Basic is not selected by default');
  browser('click', ref(profile, 'radio "Расширенная'));
  await eventually(() => metadata()?.scheme === 'extended' && metadata()?.offline_ready, 'extended bootstrap');
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
  console.log('Account offline browser smoke passed');
} catch (error) {
  try { console.error('Failed page:', body()); browser('screenshot', resolve(root, '.expo/account-offline-failure.png')); } catch { /* browser failed */ }
  throw error;
} finally {
  try { browser('set','offline','off'); browser('close'); } catch { /* failed browser may already be closed */ }
  server?.kill();
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
  await db.end().catch(() => undefined);
}
