import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { openSync, closeSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { closeSmokeBrowser, stopSmokeServer } from './smoke-process-cleanup.mjs';

export async function verifyDeadlineBrowser({ api, db, owner, ids, token, project, task, item }) {
  const data = async (query) => { const r = await query; if (r.error) throw new Error(JSON.stringify(r.error)); return r.data; };
  await db.query("update private.offline_runtime_config set write_enabled=true,sync_enabled=true,updated_at=now()");
  await db.query("update public.profiles set display_name='Тест дедлайнов' where id=$1", [ids[0]]);
  const nextTask = await data(owner.rpc('create_task', { p_project_id: project, p_title: 'Горящий этап' }));
  const nextItem = await data(owner.rpc('create_task_item', { p_task_id: nextTask, p_title: 'Горящий чек-лист' }));
  for (const id of [task, nextTask]) await data(owner.rpc('add_task_assignee', { p_task_id: id, p_user_id: ids[0] }));
  const version = (await data(owner.from('task_items').select('sync_version').eq('id', item).single())).sync_version;
  for (const [id, v] of [[item, version], [nextItem, 1]]) await data(owner.rpc('set_task_item_deadline', { p_task_item_id: id, p_expected_version: v, p_deadline_at: new Date(Date.now() + 3_600_000).toISOString() }));
  await db.query("update public.task_items set deadline_at=now()-interval '1 minute' where id=$1", [item]);
  const users = ids.map((id) => ({ id, email: `${id}@deadline.test`, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }));
  const session = { access_token: token(ids[0]), refresh_token: 'synthetic-deadline-test-refresh', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: users[0] };
  const configFile = resolve(tmpdir(), `deadline-proxy-${process.pid}.json`);
  const initFile = resolve(tmpdir(), `deadline-init-${process.pid}.js`);
  writeFileSync(configFile, JSON.stringify({ api, users }));
  writeFileSync(initFile, `if(location.origin==='http://127.0.0.1:55539'){localStorage.setItem('sb-127-auth-token',${JSON.stringify(JSON.stringify(session))});}window.__deadlineErrors=[];addEventListener('error',e=>window.__deadlineErrors.push(e.message));`);
  const name = `deadline-ui-${process.pid}`;
  const base = 'http://127.0.0.1:55539';
  const server = spawn(process.execPath, ['scripts/deadline-test-proxy.mjs', configFile], { stdio: 'ignore', windowsHide: true });
  const command = (...args) => {
    const output = resolve(tmpdir(), `deadline-browser-${process.pid}-${Date.now()}.log`); const fd = openSync(output, 'w');
    try {
      const cliArgs = ['--offline', 'agent-browser', '--session', name, '--init-script', initFile, ...args];
      const r = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'npx', process.platform === 'win32' ? ['/d', '/s', '/c', 'npx', ...cliArgs] : cliArgs,
        { timeout: 60_000, windowsHide: true, stdio: ['ignore', fd, fd] });
      const body = readFileSync(output, 'utf8').trim();
      if (r.error || r.status) throw new Error(`Browser ${args[0]}: ${r.error?.message ?? body}`); return body;
    } finally { closeSync(fd); try { unlinkSync(output); } catch { /* daemon log */ } }
  };
  const eventually = async (probe, label) => {
    for (let n = 0; n < 50; n++) { if (await probe()) return; await new Promise((resolve) => setTimeout(resolve, 200)); }
    throw new Error(`Browser timeout: ${label}`);
  };
  const body = () => command('get', 'text', 'body');
  const has = (label) => eventually(() => body().includes(label), label);
  const click = (label) => {
    const snapshot = command('snapshot', '-i');
    const line = snapshot.split('\n').find((line) => line.includes(label) && /ref=e\d+/.test(line));
    assert.ok(line, `Control missing: ${label}\n${snapshot}`);
    command('click', '@' + line.match(/ref=(e\d+)/)[1]);
  };
  const evaluate = (script) => JSON.parse(command('eval', script));
  const noOverflow = () => assert.ok(evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow');
  try {
    await eventually(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'fixture static server');
    command('set', 'viewport', '1200', '900'); command('open', base + '/projects');
    await has('1 просроченный дедлайн'); await has('1 горящий дедлайн'); await has('Горящий этап'); noOverflow();
    mkdirSync('.expo/deadline-evidence', { recursive: true }); command('screenshot', resolve('.expo/deadline-evidence/desktop.png'));
    for (const width of [320, 390, 768, 1200]) { command('set', 'viewport', String(width), '900'); noOverflow(); }
    command('set', 'viewport', '390', '844');
    assert.ok(evaluate(`(()=>{const all=[...document.querySelectorAll('*')];const nick=all.find(e=>e.textContent==='Тест дедлайнов');const template=[...document.querySelectorAll('[role="link"]')].find(e=>e.textContent==='Шаблоны');return nick&&template&&nick.getBoundingClientRect().bottom<=template.getBoundingClientRect().top})()`), 'Mobile nickname/nav rows');
    command('screenshot', resolve('.expo/deadline-evidence/mobile.png'));
    command('open', `${base}/projects/${project}`); await has('2 этапа');
    assert.ok(evaluate(`(()=>{const tabs=document.querySelector('[aria-label="Этапы проекта"]');const title=[...document.querySelectorAll('*')].find(e=>e.textContent==='Этапы (2)');return tabs&&title&&tabs.getBoundingClientRect().top>=title.getBoundingClientRect().bottom})()`), 'Stage tabs are not below heading');
    command('open', `${base}/projects/${project}/tasks/${task}?item=${item}`); await has('Изменить дедлайн');
    assert.ok(evaluate(`(()=>{const history=[...document.querySelectorAll('[role="button"]')].find(e=>e.textContent==='История');return history&&Math.abs(history.getBoundingClientRect().left-16)<2})()`), 'Mobile history alignment');
    click('Изменить дедлайн'); await has('Часовой пояс:');
    const today = new Date();
    const chosenDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 5);
    const months = (chosenDay.getFullYear() - today.getFullYear()) * 12 + chosenDay.getMonth() - today.getMonth();
    for (let n = 0; n < months; n++) click('Следующий месяц');
    const calendar = command('snapshot', '-i');
    const dayLabel = chosenDay.toLocaleDateString('ru-RU', { dateStyle: 'full' });
    const dateLine = calendar.split('\n').find((line) => line.includes(dayLabel) && /button.*ref=e\d+/.test(line));
    assert.ok(dateLine, 'Calendar future date'); command('click', '@' + dateLine.match(/ref=(e\d+)/)[1]);
    await has('Выберите часы');
    const face = evaluate(`(()=>{const face=document.querySelector('[role="slider"]');if(!face)return null;const r=face.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
    assert.ok(face, 'Analog clock face');
    command('mouse', 'move', String(face.x + face.w / 2), String(face.y + 26)); command('mouse', 'down'); command('mouse', 'up');
    await has('Выберите минуты');
    const minuteFace = evaluate(`(()=>{const r=document.querySelector('[role="slider"]').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
    command('mouse', 'move', String(minuteFace.x + minuteFace.w - 26), String(minuteFace.y + minuteFace.h / 2)); command('mouse', 'down'); command('mouse', 'up');
    click('PM · после полудня'); command('screenshot', resolve('.expo/deadline-evidence/picker.png')); click('Подтвердить');
    await eventually(async () => {
      const result = await db.query('select deadline_at from public.task_items where id=$1', [item]);
      return result.rows[0].deadline_at.getTime() > Date.now() + 86_400_000;
    }, 'UI deadline saved to database');
    command('open', base + '/projects'); await has('1 горящий дедлайн');
    assert.ok(!body().includes('1 просроченный дедлайн'), 'Moved deadline remained overdue');
    assert.deepEqual(evaluate('window.__deadlineErrors'), []);
    console.log('PASS browser: 320/390/768/1200px, mobile header/action alignment, stage tabs, counters, calendar/dial/AM-PM → real RPC → database → overview');
    console.log('Browser boundary: synthetic Auth session; live Realtime transport and physical devices are not part of this fixture.');
  } finally {
    try { closeSmokeBrowser(command); } catch { /* server cleanup still runs */ }
    await stopSmokeServer(server); for (const file of [configFile, initFile]) try { unlinkSync(file); } catch { /* cleanup */ }
  }
}
