// Run via run-security-integrations: real app, isolated Auth/PostgREST/Realtime.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { fixtureCas } from './fixture-cas.mjs';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';
import { stopSmokeServer } from './smoke-process-cleanup.mjs';
import { sanitize } from './release-ci-process.mjs';
const local=getLocalSupabaseStatus(); if(local.kind!=='tasktrace-isolated-security-test')throw Error('Disposable stack required');
const db=new pg.Client({connectionString:local.DB_URL});
const options={auth:{persistSession:false,autoRefreshToken:false}};
const admin=createClient(local.API_URL,local.SERVICE_ROLE_KEY,options),owner=createClient(local.API_URL,local.ANON_KEY,options);
const base='http://127.0.0.1:4183',password='AuditFixesUnique9!',email='audit-fixes-'+process.pid+'@test.local';
const evidence=resolve('.expo/audit-fixes',`${Date.now()}-${process.pid}`);mkdirSync(evidence,{recursive:true});
const rpc=async(name,args)=>{const r=await fixtureCas(owner,name,args);if(r.error)throw r.error;return r.data;};
const measurements=[],failures=[],profileResponses=[],templateResponses=[],browserEvents=[],checks=[];let browser,context,server,user,page;
async function check(label,fn){
 const entry={label,startedAt:new Date().toISOString()};checks.push(entry);
 try{await fn();entry.status='PASS';console.log('PASS '+label);}
 catch(e){
  entry.status='FAIL';entry.error=sanitize(e.message);failures.push(label);console.error('FAIL '+label+': '+e.message);
  if(page){
   const report={url:page.url(),profileResponses,templateResponses,browserEvents,checks,diagnosticErrors:[]};
   try{report.profile=(await db.query('select display_name from public.profiles where id=$1',[user])).rows;report.templates=(await db.query('select to_jsonb(t) value from public.task_templates t')).rows;}
   catch(error){report.diagnosticErrors.push(sanitize(error.message));}
   try{report.cache=await page.evaluate(async user=>{
    const request=indexedDB.open('tasktrace-local-cache');const cache=await new Promise((ok,no)=>{request.onsuccess=()=>ok(request.result);request.onerror=()=>no(request.error);});
    try{if(!cache.objectStoreNames.contains('entries'))return null;return await new Promise((ok,no)=>{const read=cache.transaction('entries').objectStore('entries').get(user+':templates');read.onsuccess=()=>ok(read.result??null);read.onerror=()=>no(read.error);});}finally{cache.close();}
   },user);}catch(error){report.diagnosticErrors.push(sanitize(error.message));}
   try{writeFileSync(resolve(evidence,'failure-'+failures.length+'.txt'),sanitize(await page.locator('body').innerText({timeout:2000})));await page.screenshot({path:resolve(evidence,'failure-'+failures.length+'.png'),fullPage:true,timeout:5000});}
   catch(error){report.diagnosticErrors.push(sanitize(error.message));}
   writeFileSync(resolve(evidence,'failure-'+failures.length+'.json'),sanitize(JSON.stringify(report,null,2)));
  }
 }finally{entry.finishedAt=new Date().toISOString();}
}
async function eventually(probe){const end=Date.now()+10000;while(Date.now()<end){if(await probe())return;await new Promise(r=>setTimeout(r,50));}throw Error('Expected browser transition did not finish');}
try{
 await db.connect(); const created=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{display_name:'Original name'}});
 if(created.error)throw created.error;user=created.data.user.id;
 assert.equal((await owner.auth.signInWithPassword({email,password})).error,null);
 const project=await rpc('create_project',{p_name:'Audit fixes browser'}),task=await rpc('create_task',{p_project_id:project,p_title:'Stage geometry'});
 const item=await rpc('create_task_item',{p_task_id:task,p_title:'LongToken'.repeat(15)});
 await rpc('set_task_item_percentage',{p_task_item_id:item,p_percentage:45});
 await new Promise((ok,no)=>{const child=spawn(process.execPath,['scripts/build-phase6-local-smoke.mjs'],{stdio:'inherit',windowsHide:true});child.on('error',no);child.on('exit',c=>c===0?ok():no(Error('Export '+c)));});
 server=spawn(process.execPath,['scripts/serve-web.mjs'],{env:{...process.env,PORT:'4183'},stdio:'ignore',windowsHide:true});
 for(let n=0;n<100;n++){try{if((await fetch(base)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 // These UI error contracts inject HTTP outcomes with route(). PWA/service
 // worker acceptance runs separately with real workers in the mandatory plan.
 browser=await chromium.launch({headless:true});context=await browser.newContext({serviceWorkers:'block'});
 await context.tracing.start({screenshots:true,snapshots:true,sources:true});
 await context.route('**/*',route=>[base,new URL(local.API_URL).origin].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
 page=await context.newPage();page.on('response',async response=>{if(response.url().endsWith('/rpc/execute_client_mutation_v3')){const request=response.request().postDataJSON();if(request?.p_name==='update_my_profile')profileResponses.push({request,status:response.status(),body:await response.json().catch(()=>null)});}if(response.url().includes('/rpc/get_task_template_page_v2'))templateResponses.push({at:new Date().toISOString(),request:response.request().postDataJSON(),status:response.status(),body:await response.json().catch(()=>null)});});
 page.on('console',message=>browserEvents.push({at:new Date().toISOString(),type:message.type(),text:sanitize(message.text())}));
 page.on('pageerror',error=>browserEvents.push({at:new Date().toISOString(),type:'pageerror',text:sanitize(error.message)}));
 page.on('requestfailed',request=>browserEvents.push({at:new Date().toISOString(),type:'requestfailed',url:new URL(request.url()).pathname,error:request.failure()?.errorText}));
 await page.goto(base+'/login');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Пароль',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('heading',{name:'Проекты',exact:true}).waitFor();
 await check('P05 real project and stage progress geometry',async()=>{
  for(const width of [320,360,390,768,1280])for(const path of [`/projects/${project}/progress`,`/projects/${project}/tasks/${task}/progress`]){
   await page.setViewportSize({width,height:900});await page.goto(base+path);await page.getByText('Выполнен частично: 0% → 45%',{exact:true}).waitFor();
   await page.screenshot({path:resolve(evidence,`progress-${width}-${path.includes('/tasks/')?'task':'project'}.png`),fullPage:true});
   const measured=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('[data-testid="daily-progress-content"]')].some(n=>n.scrollWidth>n.clientWidth+1)}));
   const statusBox=await page.getByText('Выполнен частично: 0% → 45%',{exact:true}).boundingBox();
   measurements.push({width,path,...measured,statusBox});assert(measured.document<=width+1&&!measured.overflow&&statusBox&&statusBox.x>=0&&statusBox.x+statusBox.width<=width+1,'Clipped status: '+JSON.stringify({measured,statusBox}));
  }
 });
 await check('P05 dark theme and 200% zoom preserve all progress fields',async()=>{
  await page.emulateMedia({colorScheme:'dark'});
  for(const width of [320,1280])for(const zoom of [1,2])for(const path of [`/projects/${project}/progress`,`/projects/${project}/tasks/${task}/progress`]){
   await page.setViewportSize({width,height:900});await page.goto(base+path);
   await page.getByText('Выполнен частично: 0% → 45%',{exact:true}).waitFor();
   await page.evaluate(value=>{document.documentElement.style.zoom=String(value);},zoom);
   await eventually(async()=>{const box=await page.getByText('Выполнен частично: 0% → 45%',{exact:true}).boundingBox();return box&&box.x+box.width<=width+1;});
   const geometry=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('[data-testid="daily-progress-content"]')].some(n=>n.scrollWidth>n.clientWidth+1)}));
   assert(geometry.document<=width+1&&!geometry.overflow,JSON.stringify({width,zoom,geometry}));measurements.push({width,zoom,theme:'dark',path,...geometry});
   await page.screenshot({path:resolve(evidence,`progress-dark-${width}-zoom${zoom}-${path.includes('/tasks/')?'task':'project'}.png`),fullPage:true});
  }
  await page.emulateMedia({colorScheme:'light'});
 });
 await page.setViewportSize({width:1000,height:900});
 await check('B06 profile conflict preserves draft and explicit rebase saves it',async()=>{
  await page.goto(base+'/profile');await page.getByRole('button',{name:'Изменить ник',exact:true}).click();await page.getByLabel('Ник',{exact:true}).fill('My preserved draft');
  await rpc('update_my_profile',{p_display_name:'Other session'});
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await page.getByRole('button',{name:'Продолжить с моим черновиком',exact:true}).waitFor();assert.equal(await page.getByLabel('Ник',{exact:true}).inputValue(),'My preserved draft');
  await page.getByRole('button',{name:'Продолжить с моим черновиком',exact:true}).click();
  await rpc('update_my_profile',{p_display_name:'Other session again'});await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await page.getByRole('button',{name:'Продолжить с моим черновиком',exact:true}).waitFor();assert.equal(await page.getByLabel('Ник',{exact:true}).inputValue(),'My preserved draft');
  await page.getByRole('button',{name:'Продолжить с моим черновиком',exact:true}).click();await page.getByRole('button',{name:'Сохранить',exact:true}).click();
  await page.getByText('Ник сохранён.',{exact:true}).waitFor();assert.equal((await db.query('select display_name from public.profiles where id=$1',[user])).rows[0].display_name,'My preserved draft');
 });
 await check('B06 + P02 quota rejection preserves profile draft and retry UUID',async()=>{
  const policy=(await db.query('select max_receipts from private.client_operation_window_policy')).rows[0].max_receipts,ids=[];
  const capture=async route=>{const args=route.request().postDataJSON();if(args.p_name==='update_my_profile')ids.push(args.p_operation_id);await route.continue();};
  await context.route('**/rest/v1/rpc/execute_client_mutation_v3',capture);
  await page.getByRole('button',{name:'Изменить ник',exact:true}).click();await page.getByLabel('Ник',{exact:true}).fill('Quota preserved draft');
  try{
   await db.query("update private.client_operation_window_policy set max_receipts=(select receipt_count from private.client_operation_live_budgets where scope='user:'||$1::text)",[user]);
   await page.getByRole('button',{name:'Сохранить',exact:true}).click();await page.getByText(/Достигнут лимит операций/).waitFor();
   assert.equal(await page.getByLabel('Ник',{exact:true}).inputValue(),'Quota preserved draft');
   assert.equal((await db.query('select display_name from public.profiles where id=$1',[user])).rows[0].display_name,'My preserved draft');
  }finally{await db.query('update private.client_operation_window_policy set max_receipts=$1',[policy]);}
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();await page.getByText('Ник сохранён.',{exact:true}).waitFor();
  assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);await context.unroute('**/rest/v1/rpc/execute_client_mutation_v3',capture);
 });
 await check('B06 lost save response retains the draft and reconciles the committed profile',async()=>{
  let lost=false;const ids=[];
  const lose=async route=>{const args=route.request().postDataJSON();if(args.p_name!=='update_my_profile')return route.continue();ids.push(args.p_operation_id);
   if(!lost){lost=true;await route.fetch();await route.abort('failed');}else await route.continue();};
  await context.route('**/rest/v1/rpc/execute_client_mutation_v3',lose);
  await page.getByRole('button',{name:'Изменить ник',exact:true}).click();await page.getByLabel('Ник',{exact:true}).fill('Lost response draft');
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();await page.getByText(/Ответ сервера не получен/).waitFor();
  assert.equal(await page.getByLabel('Ник',{exact:true}).inputValue(),'Lost response draft');
  await page.getByRole('button',{name:'Сохранить',exact:true}).click();await page.getByText('Ник сохранён.',{exact:true}).waitFor();
  assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);assert.equal((await db.query('select display_name from public.profiles where id=$1',[user])).rows[0].display_name,'Lost response draft');
  await context.unroute('**/rest/v1/rpc/execute_client_mutation_v3',lose);
 });
 await check('B02 lost HTTP response, new notification and same UUID replay',async()=>{
  const seed=async key=>(await db.query("insert into public.notifications(user_id,type,title,body,dedupe_key) values($1,'task_assigned',$2,'body',$2) returning id",[user,key])).rows[0].id;
  await seed('Old bulk notice');let lost=false,fresh;const ids=[];
  await context.route('**/rest/v1/rpc/execute_client_mutation_v3',async route=>{
   const args=route.request().postDataJSON();if(args.p_name!=='mark_all_notifications_read')return route.continue();
   ids.push(args.p_operation_id);if(!lost){lost=true;await route.fetch();fresh=await seed('New bulk notice');await route.abort('failed');}else await route.continue();
  });
  await page.goto(base+'/notifications');await page.getByRole('button',{name:'Прочитать все',exact:true}).click();
  await page.getByText(/Ответ сервера не получен/).waitFor();
  await page.reload();await page.getByRole('button',{name:'Прочитать все',exact:true}).click();
  await eventually(()=>ids.length>=2);await eventually(()=>page.getByRole('button',{name:'Прочитать все',exact:true}).isEnabled());
  await page.getByRole('button',{name:'Новое уведомление: New bulk notice',exact:true}).waitFor();assert.equal(ids[0],ids[1]);
  assert.equal((await db.query('select is_read from public.notifications where id=$1',[fresh])).rows[0].is_read,false);
  await page.getByRole('button',{name:'Прочитать все',exact:true}).click();
  await eventually(()=>ids.length>=3);
  await page.getByRole('button',{name:'Прочитано уведомление: New bulk notice',exact:true}).waitFor();assert.notEqual(ids[1],ids[2]);
 });
 await check('B01 actual member form replays a lost denial without reporting success',async()=>{
  let lost=false;const ids=[];
  const lose=async route=>{const args=route.request().postDataJSON();if(args.p_name!=='add_project_member_by_identifier')return route.continue();ids.push(args.p_operation_id);
   if(!lost){lost=true;const denied=await route.fetch();assert.equal(denied.status(),400);await route.abort('failed');}else await route.continue();};
  await context.route('**/rest/v1/rpc/execute_client_mutation_v3',lose);
  await page.goto(base+`/projects/${project}/members`);await page.getByRole('button',{name:'Добавить участника',exact:true}).click();
  await page.getByLabel('Email или ник',{exact:true}).fill('unknown@audit-fixes.test');await page.getByRole('button',{name:'Добавить в проект',exact:true}).click();
  await page.getByText(/Ответ сервера не получен/).waitFor();await page.getByRole('button',{name:'Добавить в проект',exact:true}).click();
  await page.getByText('Не удалось добавить участника по указанному идентификатору.',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Email или ник',{exact:true}).inputValue(),'unknown@audit-fixes.test');assert.equal(await page.getByText('Участник добавлен в проект.',{exact:true}).count(),0);
  assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);assert.equal((await db.query('select attempts from private.member_identifier_limits where user_id=$1',[user])).rows[0].attempts,1);
  await context.unroute('**/rest/v1/rpc/execute_client_mutation_v3',lose);
 });
 await check('B03 + B04 real UI retries a 501-item snapshot after a write between HTTP pages',async()=>{
  const large=await rpc('create_task',{p_project_id:project,p_title:'Large checklist browser'});
  const seeded=await db.query("insert into public.task_items(task_id,title,position) select $1,'Bulk item '||n,n from generate_series(1,501) n returning id,position",[large]);
  const first=seeded.rows.find(row=>Number(row.position)===1).id,last=seeded.rows.find(row=>Number(row.position)===501).id;
  let changed=false;const requests=[];
  const race=async route=>{const args=route.request().postDataJSON();if(args.p_task_id!==large||args.p_mode!=='active')return route.continue();
   const response=await route.fetch();requests.push({offset:args.p_offset,revision:args.p_revision,status:response.status()});
   if(!changed&&args.p_offset===0){changed=true;await rpc('archive_task_item',{p_task_item_id:first});}
   await route.fulfill({response});};
  await context.route('**/rest/v1/rpc/get_task_item_snapshot_page',race);await page.goto(base+`/projects/${project}/tasks/${large}`);
  const snapshot=()=>page.evaluate(async({user,large})=>{const db=await new Promise((ok,no)=>{const r=indexedDB.open('tasktrace-local-cache');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});
   try{return await new Promise((ok,no)=>{const r=db.transaction('entries').objectStore('entries').get(user+':items:'+large+':active');r.onsuccess=()=>ok(r.result?JSON.parse(r.result.data):null);r.onerror=()=>no(r.error);});}finally{db.close();}},{user,large});
  await eventually(async()=>{const rows=await snapshot();return changed&&rows?.length===500&&rows.some(row=>row.id===last)&&!rows.some(row=>row.id===first);});
  assert(requests.some(request=>request.offset===500&&request.status===409),JSON.stringify(requests));
  assert.equal(new Set((await snapshot()).map(row=>row.id)).size,500);
  await page.getByText('Чек-лист',{exact:true}).waitFor();
  await context.unroute('**/rest/v1/rpc/get_task_item_snapshot_page',race);
 });
 await check('P04 destructive failures stay inside their active dialogs and clear on reopen',async()=>{
  const deniedOperations=[];
  const deny=async route=>{if(route.request().method()!=='POST')return route.continue();const args=route.request().postDataJSON();if(!['archive_project','hard_delete_project','hard_delete_task','hard_delete_task_item','archive_task_template','delete_task_template_item'].includes(args?.p_name))return route.continue();
   deniedOperations.push(args.p_name);browserEvents.push({at:new Date().toISOString(),type:'injected403',operation:args.p_name});
   await route.fulfill({status:403,contentType:'application/json',headers:{'access-control-allow-origin':base,'access-control-allow-credentials':'true'},body:JSON.stringify({code:'42501',message:'Access denied',details:null,hint:null})});};
  await context.route('**/rest/v1/rpc/execute_client_mutation_v3',deny);
  const error='Доступ запрещён. У вашей роли нет прав на это действие.';
  async function failDialog(title,button){const dialog=page.getByLabel(title,{exact:true});await dialog.getByRole('button',{name:button,exact:true}).click();
   await dialog.getByRole('alert').getByText(error,{exact:true}).waitFor();await dialog.getByRole('button',{name:'Отмена',exact:true}).click();await dialog.waitFor({state:'hidden'});return dialog;}
  await page.goto(base+`/projects/${project}`);await page.getByRole('button',{name:'Архивировать проект',exact:true}).click();
  await failDialog('Архивировать проект?','Архивировать');await page.getByRole('button',{name:'Архивировать проект',exact:true}).click();
  assert.equal(await page.getByLabel('Архивировать проект?',{exact:true}).getByRole('alert').count(),0);await page.getByRole('button',{name:'Отмена',exact:true}).click();
  await rpc('archive_project',{p_project_id:project});await page.reload();await page.getByRole('button',{name:'Удалить навсегда',exact:true}).click();await failDialog('Удалить проект навсегда?','Удалить навсегда');
  await rpc('restore_project',{p_project_id:project});await rpc('archive_task',{p_task_id:task});
  await page.goto(base+`/projects/${project}/tasks/${task}`);await page.getByRole('button',{name:'Удалить навсегда',exact:true}).click();await failDialog('Удалить этап навсегда?','Удалить навсегда');
  await rpc('restore_task',{p_task_id:task});await rpc('archive_task_item',{p_task_item_id:item});await page.reload();
  await page.getByRole('button',{name:'Архивировать этап',exact:true}).waitFor();await page.getByRole('tab',{name:'Архив',exact:true}).click();
  await page.getByRole('button',{name:/^Открыть детали пункта /}).click();await page.getByRole('button',{name:'Удалить навсегда',exact:true}).click();await failDialog('Удалить пункт навсегда?','Удалить навсегда');
  const template=await rpc('create_task_template',{p_name:'Dialog template'});await rpc('create_task_template_item',{p_template_id:template,p_title:'Dialog item'});
  await page.goto(base+'/templates');await page.getByRole('button',{name:'Раскрыть шаблон Dialog template',exact:true}).click();
  await page.getByText('1. Dialog item',{exact:true}).waitFor();await page.getByRole('button',{name:'Удалить',exact:true}).nth(1).waitFor();
  await page.getByRole('button',{name:'Удалить',exact:true}).first().click();await failDialog('Удалить шаблон?','Удалить');
  await page.getByRole('button',{name:'Удалить',exact:true}).nth(1).click();await page.getByLabel('Удалить пункт шаблона?',{exact:true}).waitFor();assert.equal(await page.getByLabel('Удалить пункт шаблона?',{exact:true}).getByRole('alert').count(),0);await failDialog('Удалить пункт шаблона?','Удалить пункт');
  assert.equal((await db.query('select count(*)::int n from public.projects where id=$1',[project])).rows[0].n,1);
  assert.deepEqual(deniedOperations,['archive_project','hard_delete_project','hard_delete_task','hard_delete_task_item','archive_task_template','delete_task_template_item']);
  await context.unroute('**/rest/v1/rpc/execute_client_mutation_v3',deny);
 });
 writeFileSync(resolve(evidence,'results.json'),sanitize(JSON.stringify({measurements,failures,checks,templateResponses,browserEvents},null,2)));
 if(failures.length)throw Error('Browser regressions: '+failures.join(', '));
}finally{try{if(context)await context.tracing.stop({path:resolve(evidence,'trace.zip')});}finally{await browser?.close();if(server)await stopSmokeServer(server);await db.end();}}
