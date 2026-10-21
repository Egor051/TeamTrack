import { fixtureCas } from './fixture-cas.mjs';
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
  await data(fixtureCas(owner, 'update_task_item', { p_task_item_id: item, p_title: 'Очень длинное название пункта чек-листа для проверки мобильного экрана: ' + 'Согласование подробных требований и результатов работ. '.repeat(5) }));
  const nextTask = await data(owner.rpc('create_task', { p_project_id: project, p_title: 'Горящий этап' }));
  const nextItem = await data(owner.rpc('create_task_item', { p_task_id: nextTask, p_title: 'Горящий чек-лист' }));
  const archivedTask = await data(owner.rpc('create_task', { p_project_id: project, p_title: 'Архивный этап для статистики' }));
  const archivedItem = await data(owner.rpc('create_task_item', { p_task_id: archivedTask, p_title: 'Архив не входит в обзор' }));
  await data(fixtureCas(owner, 'set_task_item_percentage', { p_task_item_id: archivedItem, p_percentage: 50 }));
  const archivedVersion = (await data(owner.from('task_items').select('sync_version').eq('id', archivedItem).single())).sync_version;
  await data(owner.rpc('set_task_item_deadline', { p_task_item_id: archivedItem, p_expected_version: archivedVersion, p_deadline_at: new Date(Date.now() + 3_600_000).toISOString() }));
  await data(owner.rpc('archive_task', { p_task_id: archivedTask }));
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
    // The CLI's interactive-only tree omits some menuitem nodes. Scroll the
    // actual menu entry, then exercise it with a real pointer click.
    const menu = JSON.parse(command('eval', `(()=>{const e=[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.replace(/Выбрано$/, '').trim()===${JSON.stringify(label)});if(!e)return false;e.scrollIntoView({block:'center'});return true})()`));
    if (menu) {
      const point = JSON.parse(command('eval', `(()=>{const e=[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.replace(/Выбрано$/, '').trim()===${JSON.stringify(label)});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,visible:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`));
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y) && point.visible, `Menu entry is covered: ${label}`);
      command('mouse', 'move', String(Math.round(point.x)), String(Math.round(point.y))); command('mouse', 'down'); command('mouse', 'up'); return;
    }
    const dialogTarget = JSON.parse(command('eval', `(()=>{const root=[...document.querySelectorAll('[role="dialog"]')].at(-1);if(!root)return false;const elements=[...root.querySelectorAll('[role="button"],[role="radio"],[role="link"],[role="checkbox"]')].filter(e=>e.getAttribute('aria-disabled')!=='true');const name=e=>e.getAttribute('aria-label')||e.textContent.trim();const e=elements.find(e=>name(e)===${JSON.stringify(label)})||elements.find(e=>name(e).includes(${JSON.stringify(label)}));if(!e)return false;e.setAttribute('data-fixture-click','current');e.scrollIntoView({block:'center'});return true})()`));
    if (dialogTarget) {
      const point = JSON.parse(command('eval', `(()=>{const e=document.querySelector('[data-fixture-click="current"]');e.removeAttribute('data-fixture-click');const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,visible:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})()`));
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y) && point.visible, `Active dialog control is covered: ${label}`);
      command('mouse', 'move', String(Math.round(point.x)), String(Math.round(point.y))); command('mouse', 'down'); command('mouse', 'up'); return;
    }
    const snapshot = command('snapshot', '-i');
    const line = snapshot.split('\n').find((line) => line.includes(`"${label}"`) && /ref=e\d+/.test(line))
      ?? snapshot.split('\n').find((line) => line.includes(label) && /ref=e\d+/.test(line));
    assert.ok(line, `Control missing: ${label}\n${snapshot}`);
    const target = '@' + line.match(/ref=(e\d+)/)[1];
    if (line.includes('menuitem')) command('scrollintoview', target);
    command('click', target);
  };
  const evaluate = (script) => JSON.parse(command('eval', script.replace(/\r?\n/g, ' ')));
  const noOverflow = () => assert.ok(evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Horizontal overflow');
  const testStageLayout = async () => {
    mkdirSync('.expo/deadline-evidence', { recursive: true });
    for (const width of [320, 390, 768, 1200]) {
      command('set', 'viewport', String(width), '900'); command('open', `${base}/projects/${project}/tasks/${task}?item=${item}`); await has('Обзор этапа'); await has('Изменить дедлайн'); noOverflow();
      const layout = evaluate(`(()=>{
        const leaves=Array.from(document.querySelectorAll('*')).filter(e=>e.childElementCount===0);
        const heading=leaves.find(e=>e.textContent==='Обзор этапа'); const overview=heading.parentElement.parentElement;
        const status=document.querySelector('[aria-label^="Статус:"]');
        const date=leaves.find(e=>e.textContent.startsWith('Дедлайн: '));
        const badge=Array.from(date.parentElement.parentElement.querySelectorAll('*')).find(e=>e.childElementCount===0&&e.textContent==='Просрочен дедлайн');
        const buttons=Array.from(document.querySelectorAll('[role="button"]'));
        const deadline=buttons.find(e=>e.textContent==='Изменить дедлайн'); const save=buttons.find(e=>e.textContent==='Сохранить прогресс');
        const input=document.querySelector('input[aria-label="Прогресс, от 1 до 100%"]');
        return {overview:overview.contains(status)&&overview.textContent.includes('Владелец')&&!overview.textContent.includes('Роль:'),dateRight:date.getBoundingClientRect().right,
          badgeAbove:!!badge&&badge.getBoundingClientRect().bottom<=date.getBoundingClientRect().top,
          controlsBelow:deadline.getBoundingClientRect().top>=Math.max(input.getBoundingClientRect().bottom,save.getBoundingClientRect().bottom)};
      })()`);
      assert.ok(layout.overview, 'Role/status escaped the stage overview'); assert.ok(layout.badgeAbove, 'Deadline status is not above its date');
      assert.ok(layout.controlsBelow, 'Deadline controls are not below the progress editor'); assert.ok(layout.dateRight <= width, 'Deadline overflows the screen');
      evaluate(`Array.from(document.querySelectorAll('[role="heading"]')).find(e=>e.textContent==='Обзор этапа').scrollIntoView({block:'start'})`);
      command('screenshot', resolve(`.expo/deadline-evidence/stage-${width}.png`));
    }
    console.log('PASS stage layout: 320/390/768/1200px, long checklist title, role/status inside overview, status above deadline date, controls below progress');
  };
  const touchDial = async (points) => {
    const endpoint = command('get', 'cdp-url');
    const ws = new WebSocket(endpoint.replace(/^"|"$/g, ''));
    let sequence = 0; const pending = new Map();
    ws.addEventListener('message', (event) => { const value = JSON.parse(event.data); const item = pending.get(value.id); if (item) { pending.delete(value.id); value.error ? item.reject(new Error(JSON.stringify(value.error))) : item.resolve(value.result); } });
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    try {
      const { targetInfos } = await send('Target.getTargets');
      const target = targetInfos.find((target) => target.type === 'page' && target.url.startsWith(base)); assert.ok(target, 'Touch target');
      const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }, sessionId);
      for (let i = 0; i < points.length; i++) await send('Input.dispatchTouchEvent', { type: i ? 'touchMove' : 'touchStart', touchPoints: [{ ...points[i], id: 1 }] }, sessionId);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
      await send('Emulation.setTouchEmulationEnabled', { enabled: false }, sessionId);
    } finally { ws.close(); }
  };
  const testNotifications = async () => {
    command('open', base + '/notifications'); await has('Все проекты');
    const beforeDraft = evaluate(`Array.from(document.querySelectorAll('[aria-label*="уведомление:"]'),e=>e.textContent)`);
    click('Фильтр по проекту'); click('API deadline project'); click('Готово');
    click('Фильтр по этапу'); click('API stage'); click('Готово');
    assert.deepEqual(evaluate(`Array.from(document.querySelectorAll('[aria-label*="уведомление:"]'),e=>e.textContent)`), beforeDraft, 'Draft selection changed the list before Apply');
    click('С: начала'); await has('Дата и время не выбраны');
    click(new Date().toLocaleDateString('ru-RU', { dateStyle: 'full' })); await has('Выберите часы');
    for (const label of ['Выберите часы', 'Выберите минуты']) {
      await has(label);
      const face = evaluate(`(()=>{const r=document.querySelector('[role="slider"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+23}})()`);
      command('mouse', 'move', String(face.x), String(face.y)); command('mouse', 'down'); command('mouse', 'up');
    }
    click('Подтвердить'); await has('Все действия');
    click('Фильтр по действию');
    command('screenshot', resolve('.expo/deadline-evidence/action-filter.png'));
    click('Просрочен дедлайн'); click('Дедлайн установлен'); click('Готово'); click('Применить'); await has('Просрочен дедлайн');
    click('Отметить прочитанным'); await has('Прочитано');
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(evaluate(`document.querySelector('[aria-label$="уведомление: Просрочен дедлайн"]')?.getAttribute('aria-label')`), 'Прочитано уведомление: Просрочен дедлайн', 'Acknowledged row flickered back to unread');
    click('Фильтр по прочтению'); click('Непрочитанные'); click('Готово'); click('Применить');
    await eventually(() => evaluate(`document.querySelectorAll('[aria-label^="Прочитано уведомление:"]').length`) === 0, 'Applied unread filter');
    assert.equal(evaluate(`document.querySelectorAll('[aria-label^="Прочитано уведомление:"]').length`), 0, 'Read filter admitted a read notice');
    click('Сбросить фильтры'); await has('Все действия'); click('Применить');
    command('screenshot', resolve('.expo/deadline-evidence/notifications.png')); noOverflow();
  };
  const metadata = () => evaluate(`(async()=>{const db=await new Promise((ok,no)=>{const r=indexedDB.open('tasktrace-local-cache');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});try{return await new Promise((ok,no)=>{const r=db.transaction('entries').objectStore('entries').get('${ids[0]}:bootstrap:metadata');r.onsuccess=()=>ok(r.result?JSON.parse(r.result.data):null);r.onerror=()=>no(r.error)})}finally{db.close()}})()`);
  const testOfflineRecovery = async () => {
    command('open', base + '/projects'); await has('Офлайн: готово');
    assert.equal(metadata().basic_ready, true);
    click('Профиль'); await has('Расширенная');
    await fetch(base + '/__test/bootstrap-pages?blocked=1');
    click('Расширенная');
    await eventually(() => { const meta=metadata(); return meta?.scheme==='extended' && meta.basic_ready && !meta.extended_ready && (meta.status==='offline_waiting' || meta.retry?.reason==='transport'); }, 'interrupted Extended remains Basic only');
    command('set', 'offline', 'on'); command('open', base + '/projects'); await has('Офлайн:');
    assert.equal(metadata().extended_ready, false, 'Basic was counted as complete Extended');
    await fetch(base + '/__test/bootstrap-pages?blocked=0'); command('set', 'offline', 'off');
    await has('Офлайн: готово'); assert.equal(metadata().extended_ready, true);
    click('Уведомления'); await has('Все проекты');
    click('Профиль'); await has('Расширенная'); click('Базовая'); click('Расширенная');
    command('open', base + '/projects'); await has('Офлайн: готово');
    assert.equal(metadata().extended_ready, true, 'Foreground reads or scheme switches lost Extended coverage');
    console.log('PASS isolated PWA: real IndexedDB Basic/Extended, interrupted optional downloads, offline reload, automatic reconnect and scheme switches');
  };
  const testMembers = async () => {
    const memberName = (await db.query('select display_name from public.profiles where id=$1', [ids[1]])).rows[0].display_name || ids[1].slice(0, 8);
    const memberSelector = `[aria-label=${JSON.stringify(`Роль чек-листа для ${memberName}`)}]`;
    click('Участники и исполнители'); await has('Доступ к этапу');
    assert.ok(!body().includes('Добавить участника проекта') && !body().includes('Участники этапа'), 'Stage dialog duplicates project membership');
    assert.equal(evaluate(`document.querySelector('[aria-label="Роль чек-листа для Тест дедлайнов"]')?.getAttribute('aria-disabled')`), 'true', 'Own role selector is enabled');
    command('click', memberSelector); await has('Наследовать:');
    command('press', 'Escape'); await has('Доступ к этапу');
    assert.equal(evaluate(`document.querySelectorAll('[role="menuitem"]').length`), 0, 'Escape did not dismiss only the child');
    command('click', memberSelector); await has('Наследовать:');
    command('mouse', 'move', '14', '14'); command('mouse', 'down'); command('mouse', 'up');
    await has('Доступ к этапу'); assert.equal(evaluate(`document.querySelectorAll('[role="menuitem"]').length`), 0, 'Outside click did not dismiss the child');
    const rapid = evaluate(`(async()=>{const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));for(let n=0;n<10;n++){
      document.querySelector(${JSON.stringify(memberSelector)}).click();await frame();
      document.dispatchEvent(new KeyboardEvent('keyup',{key:'Escape',bubbles:true}));await frame();
      if(document.querySelectorAll('[aria-modal="true"]').length!==1)return false;
    }return true})()`);
    assert.equal(rapid, true, 'Rapid child dismissal retained a ghost portal or closed its parent');
    evaluate('window.__membersDocument=12345');
    command('click', memberSelector); await has('Наследовать:');
    click('Только просмотр');
    await eventually(async () => (await db.query('select role_override from public.task_members where task_id=$1 and user_id=$2',[task,ids[1]])).rows[0].role_override === 'viewer', 'stage-only role change');
    assert.equal(evaluate('window.__membersDocument'), 12345, 'Role update reloaded the document');
    await has('Доступ к этапу');
    const beforeAssignees = await data(owner.from('task_assignees').select('user_id').eq('task_id', task));
    click('Назначить'); await has('Назначить исполнителя?');
    command('mouse', 'move', '14', '14'); command('mouse', 'down'); command('mouse', 'up');
    await has('Доступ к этапу');
    assert.equal((await data(owner.from('task_assignees').select('user_id').eq('task_id', task))).length, beforeAssignees.length, 'Dismissing child confirmed assignment');
    click('Назначить'); await has('Назначить исполнителя?'); click('Назначить');
    await eventually(async () => (await data(owner.from('task_assignees').select('user_id').eq('task_id', task))).length === beforeAssignees.length + 1, 'assignee confirmation');
    command('fill', 'input[aria-label="Email или ник"]', `${ids[3]}@deadline.test`); click('Добавить в этап');
    await eventually(async () => (await db.query('select is_direct from public.task_members where task_id=$1 and user_id=$2',[task,ids[3]])).rows[0]?.is_direct === true, 'UI stage-only invite');
    assert.equal((await db.query('select count(*)::int n from public.project_members where project_id=$1 and user_id=$2',[project,ids[3]])).rows[0].n, 0, 'Stage invite changed project membership');
    await has('Удалить из этапа'); click('Удалить из этапа'); await has('Удалить прямое участие?'); click('Удалить из этапа');
    await eventually(async () => !(await db.query('select 1 from public.task_members where task_id=$1 and user_id=$2',[task,ids[3]])).rowCount, 'UI stage-only removal');
    command('screenshot', resolve('.expo/deadline-evidence/members.png'));
    click('Закрыть'); await has('Изменить дедлайн');
  };
  try {
    await eventually(async () => { try { return (await fetch(base)).ok; } catch { return false; } }, 'fixture static server');
    if (process.argv.includes('--stage-layout-only')) { await testStageLayout(); return; }
    if (process.argv.includes('--archived-only')) {
      command('set', 'viewport', '390', '844'); command('open', `${base}/projects/${project}/tasks/${archivedTask}`); await has('Архивный этап для статистики'); await has('Дедлайн:');
      assert.ok(!body().includes('Приближается дедлайн') && !body().includes('Просрочен дедлайн'), 'Archived stage emitted an active deadline badge');
      console.log('PASS archived parent: historical deadline visible, active warnings suppressed'); return;
    }
    if (process.argv.includes('--notifications-only')) {
      command('set', 'viewport', '390', '844'); await testNotifications(); console.log('PASS focused notification browser flow'); return;
    }
    if (process.argv.includes('--members-only')) {
      command('set', 'viewport', '390', '844'); command('open', `${base}/projects/${project}/tasks/${task}?item=${item}`); await has('Изменить дедлайн'); await testMembers(); console.log('PASS focused members browser flow'); return;
    }
    if (process.argv.includes('--offline-only')) {
      command('set', 'viewport', '390', '844'); await testOfflineRecovery(); return;
    }
    command('set', 'viewport', '1200', '900'); command('open', base + '/projects');
    await has('1 просроченный дедлайн'); await has('1 горящий дедлайн'); await has('Горящий этап'); noOverflow();
    mkdirSync('.expo/deadline-evidence', { recursive: true }); command('screenshot', resolve('.expo/deadline-evidence/desktop.png'));
    for (const width of [320, 390, 768, 1200]) { command('set', 'viewport', String(width), '900'); noOverflow(); }
    command('set', 'viewport', '390', '844');
    assert.ok(evaluate(`(()=>{const links=[...document.querySelectorAll('[role="link"]')];const notice=links.find(e=>e.getAttribute('aria-label')?.startsWith('Уведомления'));const template=links.find(e=>e.textContent==='Шаблоны');return notice&&template&&notice.getBoundingClientRect().left<template.getBoundingClientRect().left})()`), 'Global notifications precede templates');
    command('screenshot', resolve('.expo/deadline-evidence/mobile.png'));
    command('open', `${base}/projects/${project}`); await has('2 этапа');
    const overviewBefore = evaluate(`(()=>{const heading=[...document.querySelectorAll('*')].find(e=>e.textContent==='Обзор проекта');return heading.parentElement.parentElement.textContent})()`);
    click('Архив'); await has('Архивный этап для статистики');
    assert.equal(evaluate(`(()=>{const heading=[...document.querySelectorAll('*')].find(e=>e.textContent==='Обзор проекта');return heading.parentElement.parentElement.textContent})()`), overviewBefore, 'Archive tab changed active overview');
    click('Активные'); await has('Горящий этап');
    click('Назад'); await eventually(() => command('get', 'url').replace(/\/$/, '') === base + '/projects', 'single Back from direct project URL');
    command('open', `${base}/projects/${project}`); await has('2 этапа');
    assert.ok(evaluate(`(()=>{const tabs=document.querySelector('[aria-label="Этапы проекта"]');const title=[...document.querySelectorAll('*')].find(e=>e.textContent==='Этапы (2)');return tabs&&title&&tabs.getBoundingClientRect().top>=title.getBoundingClientRect().bottom})()`), 'Stage tabs are not below heading');
    command('open', `${base}/projects/${project}/tasks/${task}?item=${item}`); await has('Изменить дедлайн');
    click('Свернуть'); assert.ok(body().includes('Дедлайн:'), 'Collapsed details hid the deadline'); click('Открыть детали пункта');
    await testMembers();
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
    command('screenshot', resolve('.expo/deadline-evidence/hours.png'));
    const face = evaluate(`(()=>{const face=document.querySelector('[role="slider"]');if(!face)return null;const r=face.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
    assert.ok(face, 'Analog clock face');
    command('mouse', 'move', String(face.x + face.w / 2), String(face.y + 23)); command('mouse', 'down');
    command('mouse', 'move', String(face.x + face.w / 2 + 65), String(face.y + face.h / 2));
    assert.equal(evaluate(`document.querySelector('[role="slider"]').getAttribute('aria-valuenow')`), '3', 'Inner ring drag');
    command('mouse', 'move', String(face.x + face.w / 2 + 103), String(face.y + face.h / 2));
    assert.equal(evaluate(`document.querySelector('[role="slider"]').getAttribute('aria-valuenow')`), '15', 'Outer ring drag');
    command('mouse', 'up');
    assert.equal(evaluate('getSelection().toString()'), '', 'Dragging selected dial text');
    await has('Выберите минуты');
    click('Часы'); await has('Выберите часы');
    const touchFace = evaluate(`(()=>{const r=document.querySelector('[role="slider"]').getBoundingClientRect();return {x:r.x,y:r.y}})()`);
    await touchDial([{ x: touchFace.x + 70, y: touchFace.y + 158 }, { x: touchFace.x + 37, y: touchFace.y + 178 }, { x: touchFace.x + 126, y: touchFace.y + 61 }]);
    await has('Выберите минуты');
    assert.ok(body().includes('12:'), 'Touch drag did not finish on inner 12');
    const minuteFace = evaluate(`(()=>{const r=document.querySelector('[role="slider"]').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()`);
    command('mouse', 'move', String(minuteFace.x + minuteFace.w - 26), String(minuteFace.y + minuteFace.h / 2)); command('mouse', 'down'); command('mouse', 'up');
    assert.ok(!body().includes('AM ·') && !body().includes('PM ·'), 'AM/PM remains');
    command('screenshot', resolve('.expo/deadline-evidence/picker.png')); click('Подтвердить');
    await eventually(async () => {
      const result = await db.query('select deadline_at from public.task_items where id=$1', [item]);
      return result.rows[0].deadline_at.getTime() > Date.now() + 86_400_000;
    }, 'UI deadline saved to database');
    command('open', base + '/projects'); await has('1 горящий дедлайн');
    assert.ok(!body().includes('1 просроченный дедлайн'), 'Moved deadline remained overdue');
    assert.deepEqual(evaluate('window.__deadlineErrors'), []);
    await testNotifications();
    await testOfflineRecovery();
    console.log('PASS browser: 320/390/768/1200px, shared navigation, stable active overview, one Back from deep URL, own-role guard, nested Escape/outside clicks, mouse/touch captured 24-hour drag → real RPC → database → overview, notification filters and stable read');
    console.log('Browser boundary: synthetic Auth session; live Realtime transport and physical devices are not part of this fixture.');
  } catch (error) {
    try {
      command('screenshot', resolve('.expo/deadline-evidence/failure.png'));
      console.log('Browser failure geometry:', evaluate(`(()=>{const e=[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.includes('Просрочен дедлайн'));let p=e;const a=[];while(p&&a.length<7){const r=p.getBoundingClientRect();a.push({role:p.getAttribute('role'),text:p===e?p.textContent:undefined,y:r.y,h:r.height,client:p.clientHeight,scroll:p.scrollHeight,overflow:getComputedStyle(p).overflowY});p=p.parentElement}return a})()`));
      const meta = metadata(); console.log('Browser failure readiness:', meta && { scheme: meta.scheme, status: meta.status, basic: meta.basic_ready, extended: meta.extended_ready, error: meta.error, retry: meta.retry, datasets: Object.fromEntries(Object.entries(meta.datasets).map(([key,value])=>[key,value.status])) });
    } catch { /* original error remains diagnostic */ }
    throw error;
  } finally {
    try { closeSmokeBrowser(command); } catch { /* server cleanup still runs */ }
    await stopSmokeServer(server); for (const file of [configFile, initFile]) try { unlinkSync(file); } catch { /* cleanup */ }
  }
}
