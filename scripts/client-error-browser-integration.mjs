// Run ONLY through run-security-integrations.mjs. Uses its disposable database,
// synthetic Auth accounts, a local exported app and the actual Deno Edge entry.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import pg from 'pg';
import { chromium, webkit } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';
import { isAppNavigation } from './pwa-navigation.mjs';

if (!process.env.TASKTRACE_ISOLATED_CONFIG) throw new Error('Disposable integration stack required');
const config = getLocalSupabaseStatus();
const db = new pg.Client({ connectionString: config.DB_URL }); await db.connect();
const root = resolve('.expo', `client-error-e2e-${process.pid}`);
const output = resolve(root, 'web'); await mkdir(root, { recursive: true });
const children = new Set(), results = [], requests = [];
let server, edge, browser, lastPage, dataApiDown = false, origin;
const value = async q => { const r = await q; if (r.error) throw new Error(r.error.code ?? 'Fixture RPC failed'); return r.data; };
const until = async (check, label, timeout = 25000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 150)); }
  throw new Error('Timeout: ' + label);
};
const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; };
const run = (executable, args, env) => new Promise((resolveRun, reject) => {
  const child = spawn(executable, args, { windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
  let tail = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { tail = (tail + bytes).slice(-10000); });
  child.on('error', reject); child.on('exit', code => { children.delete(child); if (code) reject(new Error('Local process failed: ' + args.slice(0, 2).join(' ') + '\n' + tail.replace(/eyJ[a-zA-Z0-9_.-]+/g, '[test JWT]'))); else resolveRun(); });
});
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
const admin = createClient(config.API_URL, config.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
async function account(label) {
  const email = randomUUID() + '@client-errors.invalid', password = randomUUID() + 'aA1!';
  const created = await value(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: label } }));
  const client = createClient(config.API_URL, config.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const signed = await value(client.auth.signInWithPassword({ email, password }));
  return { id: created.user.id, email, client, session: signed.session };
}
async function seedStorage(page, session) {
  await page.addInitScript(session => {
    if (!localStorage.getItem('sb-127-auth-token')) localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
  }, session);
}
async function idb(page, userId, taskId, action) {
  return page.evaluate(async ({ userId, taskId, action }) => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('tasktrace-local-cache'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(['entries', 'pending_operations'], ['pending','diagnostics','runtime','versions'].includes(action) ? 'readonly' : 'readwrite');
        let result;
        tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error);
        if (action === 'pending') { const r = tx.objectStore('pending_operations').index('by_user_task').getAll([userId, taskId]); r.onsuccess = () => { result = r.result; }; }
        else if (action === 'diagnostics') { const r = tx.objectStore('entries').get(userId + ':diagnostics:client-errors:v1'); r.onsuccess = () => { result = r.result ? JSON.parse(r.result.data) : null; }; }
        else if (action === 'runtime') { const r = tx.objectStore('entries').get(userId + ':runtime:offline-capabilities'); r.onsuccess = () => { result = r.result ? JSON.parse(r.result.data) : null; }; }
        else if (action === 'versions') { const r = tx.objectStore('entries').get(userId + ':items:' + taskId + ':active'); r.onsuccess = () => { result = r.result ? JSON.parse(r.result.data).map(i => ({ sync_version: i.sync_version, percentage: i.percentage })) : null; }; }
        else if (action === 'remove_snapshot') tx.objectStore('entries').delete(userId + ':items:' + taskId + ':active');
        else if (action === 'blocked') tx.objectStore('pending_operations').add({ operation_id: crypto.randomUUID(), user_id: userId, project_id: 'test', task_id: taskId,
          task_item_id: globalThis.testItemId, type: 'set_task_item_state', payload: { completed: true }, created_at: new Date().toISOString(), expected_version: 1, status: 'failed', protocol_version: 3 });
      });
    } finally { db.close(); }
  }, { userId, taskId, action });
}
try {
  const edgePort = await freePort();
  server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://local').pathname;
      if (path.startsWith('/functions/v1/client-errors') || path.startsWith('/rest/v1') || path.startsWith('/auth/v1')) {
        const requestRecord = { path, method: req.method, at: Date.now() }; requests.push(requestRecord);
        if (dataApiDown && path.startsWith('/rest/v1')) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"message":"Test Data API unavailable"}'); return; }
        const target = path.startsWith('/functions/v1') ? `http://127.0.0.1:${edgePort}/` : config.API_URL + req.url;
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        if (/\/rpc\/apply_task_item_.*_operation_v3$/.test(path)) {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          requestRecord.expectedVersion = body.p_expected_version;
        }
        const upstream = await fetch(target, { method: req.method, headers: { ...req.headers, host: new URL(target).host }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
        requestRecord.status = upstream.status;
        const headers = Object.fromEntries(upstream.headers); delete headers['content-encoding']; delete headers['content-length']; delete headers['transfer-encoding'];
        const responseBytes = Buffer.from(await upstream.arrayBuffer());
        if (/\/rpc\/apply_task_item_.*_operation_v3$/.test(path)) {
          const result = JSON.parse(responseBytes.toString());
          requestRecord.result = { status: result.status, version: result.version, code: result.code };
        }
        res.writeHead(upstream.status, headers); res.end(responseBytes); return;
      }
      const resolved = resolve(output, '.' + decodeURIComponent(path));
      if (resolved !== output && !resolved.startsWith(output + sep)) { res.writeHead(403).end(); return; }
      let file = resolved;
      try { if (!(await stat(file)).isFile()) throw new Error(); }
      catch { file = isAppNavigation({ request: { mode: 'navigate' }, url: new URL(req.url, origin) }) ? resolve(output, 'index.html') : null; }
      if (!file) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': /sw\.js$|\.html$/.test(file) ? 'no-cache' : 'public,max-age=3600' });
      res.end(await readFile(file));
    } catch { if (!res.headersSent) res.writeHead(502); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); origin = 'http://127.0.0.1:' + server.address().port;
  globalThis.self = { location: { origin } }; // Browser-only navigation predicate.
  edge = spawn(process.env.TASKTRACE_DENO ?? 'deno', ['run', '--config', 'supabase/functions/client-errors/deno.json', '--allow-env', '--allow-net=127.0.0.1', 'supabase/functions/client-errors/index.ts'], {
    windowsHide: true, env: { ...process.env, SUPABASE_URL: origin, SUPABASE_ANON_KEY: config.ANON_KEY, SUPABASE_DB_URL: config.DB_URL,
      CLIENT_ERROR_DB_URL: config.DB_URL, CLIENT_ERROR_ALLOWED_ORIGINS: origin, CLIENT_ERROR_HOST: '127.0.0.1', PORT: String(edgePort) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(edge); let edgeFailure = '';
  edge.stderr.on('data', b => { edgeFailure = (edgeFailure + b).slice(-2000); });
  edge.on('error', e => { edgeFailure = e.message; });
  await until(async () => { if (edge.exitCode !== null) throw new Error('Local Edge startup failed: ' + edgeFailure); try { return (await fetch(`http://127.0.0.1:${edgePort}`, { method: 'OPTIONS' })).status === 204; } catch { return false; } }, 'Deno Edge startup');
  const buildEnv = { EXPO_NO_DOTENV: '1', EXPO_PUBLIC_SUPABASE_URL: origin, EXPO_PUBLIC_SUPABASE_ANON_KEY: config.ANON_KEY,
    EXPO_PUBLIC_OFFLINE_WRITE_ENABLED: 'true', EXPO_PUBLIC_OFFLINE_SYNC_ENABLED: 'true', EXPO_PUBLIC_CLIENT_DIAGNOSTICS_ENABLED: 'true', EXPO_PUBLIC_APP_BUILD_ID: 'abcdef1234' };
  await run(process.execPath, ['node_modules/expo/bin/cli', 'export', '--platform', 'web', '--clear', '--output-dir', output], buildEnv);
  const html = await readFile(resolve(output, 'index.html'), 'utf8');
  const entry = /src="([^\"]*entry-[^\"]+\.js)"/.exec(html)?.[1];
  assert(entry, 'Exported entry missing');
  const bundle = await readFile(resolve(output, '.' + entry), 'utf8');
  assert(bundle.includes(origin), 'Export reused a stale public API URL');
  assert(!bundle.includes('diapmbqdjunlgvivwrtp.supabase.co'), 'Production URL in isolated browser artifact');
  await run(process.execPath, ['scripts/generate-service-worker.mjs', output], buildEnv);
  console.log('PASS exported current app and started actual local Deno Edge with isolated Auth/Postgres');
  await db.query('update private.offline_runtime_config set write_enabled=true,sync_enabled=true where singleton');
  const owner = await account('Diagnostic owner');
  const project = await value(owner.client.rpc('create_project', { p_name: 'Diagnostics integration' }));
  const stage = await value(owner.client.rpc('create_task', { p_project_id: project, p_title: 'Diagnostics stage' }));
  const target = await value(owner.client.rpc('create_task_item', { p_task_id: stage, p_title: 'Diagnostic main' }));
  const itemId = typeof target === 'string' ? target : target.id;
  const url = `${origin}/projects/${project}/tasks/${stage}`;
  const serverItem = async () => (await db.query('select * from public.task_items where id=$1', [itemId])).rows[0];
  const logs = async userId => (await db.query('select * from public.client_error_logs where user_id=$1 order by received_at', [userId])).rows;
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    if (process.env.TASKTRACE_BROWSER && name !== process.env.TASKTRACE_BROWSER) continue;
    const actor = await account('Diagnostic ' + name);
    await value(owner.client.rpc('add_project_member_by_identifier', { p_project_id: project, p_identifier: actor.email, p_role: 'member' }));
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = lastPage = await context.newPage(); const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
    page.on('console', message => { if (message.type() === 'error') results.push({ browser: name, consoleError: message.text().replace(/eyJ[a-zA-Z0-9_.-]+/g, '[test JWT]') }); });
    await seedStorage(page, actor.session); await page.goto(url); await page.getByRole('checkbox').first().waitFor();
    await until(async () => (await idb(page, actor.id, stage, 'pending')).length === 0, 'initial queue');
    const before = (await serverItem()).is_completed;
    await page.getByRole('checkbox').first().click(); await until(async () => (await serverItem()).is_completed !== before, name + ' checkbox');
    await until(async () => (await idb(page, actor.id, stage, 'pending')).length === 0, 'checkbox ACK');
    // Durable ACK precedes the visible list's asynchronous refresh. Starting a
    // new draft earlier deliberately keeps its OLD version and must conflict.
    await page.getByText('Ожидает синхронизации', { exact: true }).waitFor({ state: 'hidden' });
    await page.waitForLoadState('networkidle');
    results.push({ browser: name, checkpoint: 'checkbox ACK', serverVersion: (await serverItem()).sync_version,
      cached: await idb(page, actor.id, stage, 'versions'),
      pending: (await idb(page, actor.id, stage, 'pending')).map(o => ({ expected_version: o.expected_version, status: o.status })) });
    await page.getByRole('button', { name: /^Открыть детали пункта/ }).first().click();
    await page.getByLabel('Прогресс, от 1 до 100%').fill('50');
    await page.getByRole('button', { name: 'Сохранить прогресс', exact: true }).click();
    await until(async () => (await serverItem()).percentage === 50, name + ' percentage');
    await until(async () => (await idb(page, actor.id, stage, 'pending')).length === 0, 'percentage ACK');
    await page.getByText('Ожидает синхронизации', { exact: true }).waitFor({ state: 'hidden' });
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /Добавить комментарий|Изменить комментарий/ }).click();
    const canary = 'PRIVATE_COMMENT_CANARY_' + name;
    await page.getByLabel('Комментарий к пункту').fill(canary); await page.getByRole('button', { name: 'Сохранить комментарий', exact: true }).click();
    await until(async () => (await serverItem()).comment === canary, name + ' comment');
    await until(async () => (await idb(page, actor.id, stage, 'pending')).length === 0, 'comment ACK');
    await page.getByText('Ожидает синхронизации', { exact: true }).waitFor({ state: 'hidden' });
    await page.waitForLoadState('networkidle');
    await idb(page, actor.id, stage, 'remove_snapshot');
    // Foreground refresh can restore the entry between deletion and Playwright's
    // click. Remove it at the actual enqueue read as well, in that transaction,
    // so this scenario proves the recovery path instead of depending on timing.
    await page.evaluate(({ userId, taskId }) => {
      const original = IDBObjectStore.prototype.get;
      const key = userId + ':items:' + taskId + ':active';
      globalThis.diagnosticSnapshotFaultObserved = false;
      IDBObjectStore.prototype.get = function (query) {
        if (query === key && this.name === 'entries' && this.transaction.mode === 'readwrite'
          && this.transaction.objectStoreNames.contains('pending_operations')) {
          IDBObjectStore.prototype.get = original;
          this.delete(key);
          globalThis.diagnosticSnapshotFaultObserved = true;
        }
        return original.call(this, query);
      };
    }, { userId: actor.id, taskId: stage });
    await page.getByRole('checkbox').first().click();
    await until(async () => (await serverItem()).is_completed, name + ' missing snapshot recovery');
    assert.equal(await page.evaluate(() => globalThis.diagnosticSnapshotFaultObserved), true, 'Missing snapshot reached the real enqueue boundary');
    try { await until(async () => (await logs(actor.id)).length > 0, name + ' remote diagnostic'); }
    catch (error) {
      await writeFile(resolve(root, 'diagnostic-buffer.json'), JSON.stringify(await idb(page, actor.id, stage, 'diagnostics'), null, 2));
      throw error;
    }
    const recorded = await logs(actor.id);
    assert(recorded.some(l => l.kind === 'local_data' && l.operation === 'set_task_item_state'));
    assert(!JSON.stringify(recorded).includes(canary)); assert(!JSON.stringify(recorded).includes(actor.session.access_token));
    assert(recorded.every(l => l.event.app_build === 'abcdef1234'));
    await page.evaluate(id => { globalThis.testItemId = id; }, itemId);
    await until(async () => (await idb(page, actor.id, stage, 'pending')).length === 0, 'recovery ACK');
    await idb(page, actor.id, stage, 'blocked'); await page.getByRole('checkbox').first().click();
    await page.getByText(/Сначала разрешите несинхронизированные изменения пункта/).waitFor();
    await until(async () => (await idb(page, actor.id, stage, 'diagnostics'))?.queue.some(p => p.event.kind === 'outbox_blocked'), 'blocked error buffered without storm');
    assert.equal((await idb(page, actor.id, stage, 'pending')).filter(o => o.status === 'failed').length, 1);
    await page.screenshot({ path: resolve(root, name + '-blocked.png'), fullPage: true });
    assert.equal(pageErrors.length, 0, 'Unhandled browser exceptions: ' + pageErrors.join(';'));
    results.push({ browser: name, scenarios: ['member checkbox', 'percentage', 'comment', 'missing snapshot repaired', 'remote diagnostic', 'blocked queue preserved'], pageErrors: 0 });
    console.log(`PASS ${name}: actual member checkbox/percentage/comment, missing snapshot recovery, safe remote diagnostic and blocked outbox`);
    await context.close();

    const outageActor = await account('Diagnostic outage ' + name);
    await value(owner.client.rpc('add_project_member_by_identifier', { p_project_id: project, p_identifier: outageActor.email, p_role: 'member' }));
    const offlineContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const offlinePage = lastPage = await offlineContext.newPage(); await seedStorage(offlinePage, outageActor.session);
    await offlinePage.goto(url); await offlinePage.getByRole('checkbox').first().waitFor();
    await until(async () => (await idb(offlinePage, outageActor.id, stage, 'pending')).length === 0, 'outage initial queue');
    await until(async () => (await idb(offlinePage, outageActor.id, stage, 'runtime'))?.value?.write_enabled === true, 'outage confirmed runtime');
    await offlinePage.waitForLoadState('networkidle');
    dataApiDown = true;
    await offlinePage.evaluate(async () => { await fetch('/rest/v1/projects?select=id&limit=0'); window.dispatchEvent(new Event('focus')); });
    await new Promise(r => setTimeout(r, 1500));
    await idb(offlinePage, outageActor.id, stage, 'remove_snapshot');
    await offlinePage.getByRole('checkbox').first().click();
    await offlinePage.getByText(/сначала синхронизируйте|хранилище устройства|Не удалось|Требуется авторизация|временно отключены/).first().waitFor();
    await until(async () => (await logs(outageActor.id)).length > 0, 'diagnostic delivery with Data API down');
    assert((await logs(outageActor.id)).every(l => l.event.connection === 'degraded' || l.event.connection === 'online'));
    assert.equal((await idb(offlinePage, outageActor.id, stage, 'pending')).length, 0);
    console.log(`PASS ${name}: Auth works, Data API returns 503, error reaches actual Edge and PostgreSQL`);
    dataApiDown = false; await offlineContext.close(); await browser.close(); browser = null;
  }
  // Independent physical DB connections exercise the server quota lock, rather
  // than relying on one Edge isolate's single-connection pool to serialize it.
  const quotaActor = await account('Diagnostic quota race');
  const sample = (await db.query('select event from public.client_error_logs limit 1')).rows[0].event;
  const initial = { ...sample, event_id: randomUUID(), occurred_at: new Date().toISOString(), app_build: 'face0001' };
  assert.equal((await db.query('select private.ingest_client_error($1,$2::jsonb) result', [quotaActor.id, JSON.stringify(initial)])).rows[0].result, 'accepted');
  await db.query(`insert into public.client_error_logs select user_id,gen_random_uuid(),received_at,occurred_at,app_version,app_build,kind,operation,stage,description,md5(n::text),event
    from public.client_error_logs cross join generate_series(1,18) n where user_id=$1`, [quotaActor.id]);
  await db.query("update public.client_error_logs set received_at=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC' where user_id=$1", [quotaActor.id]);
  const peers = Array.from({ length: 5 }, () => new pg.Client({ connectionString: config.DB_URL }));
  try {
    await Promise.all(peers.map(p => p.connect()));
    const attempts = peers.map((_, i) => ({ ...initial, event_id: randomUUID(), app_build: 'face' + (i + 2).toString(16).padStart(4, '0') }));
    const race = await Promise.all(peers.map((p, i) => p.query('select private.ingest_client_error($1,$2::jsonb) result', [quotaActor.id, JSON.stringify(attempts[i])])));
    assert.equal(race.filter(r => r.rows[0].result === 'accepted').length, 1);
    assert.equal(race.filter(r => r.rows[0].result === 'quota').length, 4);
    assert.equal(Number((await db.query('select count(*) from public.client_error_logs where user_id=$1', [quotaActor.id])).rows[0].count), 20);
    const winner = attempts[race.findIndex(r => r.rows[0].result === 'accepted')];
    assert.equal((await db.query('select private.ingest_client_error($1,$2::jsonb) result', [quotaActor.id, JSON.stringify(winner)])).rows[0].result, 'duplicate');
  } finally { await Promise.all(peers.map(p => p.end())); }
  console.log('PASS diagnostic quota race: five connections, one remaining slot, exactly one insert and stable lost-ACK replay');
  const sizes = (await db.query('select round(avg(octet_length(convert_to(to_jsonb(l)::text,\'UTF8\'))))::int average_bytes,max(octet_length(convert_to(to_jsonb(l)::text,\'UTF8\')))::int max_bytes,count(*)::int events from public.client_error_logs l')).rows[0];
  await writeFile(resolve(root, 'results.json'), JSON.stringify({ results, sizes, requestCounts: { diagnostics: requests.filter(r => r.path.startsWith('/functions/')).length } }, null, 2));
  console.log('PASS diagnostic event sizes: ' + JSON.stringify(sizes));
} catch (error) {
  if (lastPage && !lastPage.isClosed()) {
    await writeFile(resolve(root, 'failure.json'), JSON.stringify({ url: lastPage.url(), body: (await lastPage.locator('body').innerText()).slice(0, 5000),
      storage: await lastPage.evaluate(() => Object.keys(localStorage)), requests: requests.slice(-40), results }, null, 2));
    await lastPage.screenshot({ path: resolve(root, 'failure.png'), fullPage: true });
    console.error('Local UI evidence: ' + resolve(root, 'failure.json'));
  }
  throw error;
} finally {
  await browser?.close();
  for (const child of children) child.kill();
  if (server) await new Promise(r => server.close(r));
  await db.end();
}
