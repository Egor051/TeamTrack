// Run via run-security-integrations: real app, isolated Auth/PostgREST/Realtime.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
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
const browserName=process.env.TASKTRACE_UI_BROWSER||'chromium';assert(['chromium','webkit'].includes(browserName),'Supported UI browser required');
const evidence=resolve('.expo/audit-fixes',`${browserName}-${Date.now()}-${process.pid}`);mkdirSync(evidence,{recursive:true});
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
async function measureLayout(page){return page.evaluate(()=>{
 const root=document.documentElement,round=value=>Math.round(value*100)/100;
 const compact=node=>{
  const style=getComputedStyle(node),rect=node.getBoundingClientRect();
  return {selector:`${node.tagName.toLowerCase()}${node.id?'#'+node.id:''}${typeof node.className==='string'&&node.className.trim()?'.'+node.className.trim().split(/\s+/).join('.'):''}${node.getAttribute('data-testid')?'[data-testid="'+node.getAttribute('data-testid')+'"]':''}`,
   text:(node.innerText||node.textContent||'').trim().replace(/\s+/g,' ').slice(0,100),rect:{left:round(rect.left),right:round(rect.right),top:round(rect.top),bottom:round(rect.bottom),width:round(rect.width),height:round(rect.height)},
   client:{width:node.clientWidth,height:node.clientHeight},scroll:{width:node.scrollWidth,height:node.scrollHeight},
   styles:{display:style.display,position:style.position,boxSizing:style.boxSizing,width:style.width,minWidth:style.minWidth,maxWidth:style.maxWidth,
    flex:style.flex,flexGrow:style.flexGrow,flexShrink:style.flexShrink,flexBasis:style.flexBasis,gridTemplateColumns:style.gridTemplateColumns,
    gap:style.gap,columnGap:style.columnGap,margin:style.margin,padding:style.padding,overflowX:style.overflowX,whiteSpace:style.whiteSpace,
    wordBreak:style.wordBreak,overflowWrap:style.overflowWrap,textOverflow:style.textOverflow,transform:style.transform,zoom:style.zoom}};
 };
 const rendered=node=>{const style=getComputedStyle(node),rect=node.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0;};
 const all=[...document.querySelectorAll('body *')].filter(rendered);
 const overflowing=all.filter(node=>node.scrollWidth>node.clientWidth+1);
 const outside=all.filter(node=>{const r=node.getBoundingClientRect();return r.left < -1 || r.right > root.clientWidth+1;});
 const chain=node=>{const rows=[];for(let current=node;current&&rows.length<9;current=current.parentElement)rows.push(compact(current));return rows;};
 return {viewport:{innerWidth,innerHeight,devicePixelRatio,visualViewportWidth:visualViewport?.width??null,visualViewportScale:visualViewport?.scale??null,
   rootZoom:getComputedStyle(root).zoom,mediaColorScheme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'},
  document:{clientWidth:root.clientWidth,scrollWidth:root.scrollWidth,clientHeight:root.clientHeight,scrollHeight:root.scrollHeight},
  body:{clientWidth:document.body.clientWidth,scrollWidth:document.body.scrollWidth},
  outside:outside.slice(0,60).map(node=>({element:compact(node),ancestors:chain(node)})),
  overflowing:overflowing.slice(0,60).map(node=>({element:compact(node),ancestors:chain(node)}))};
 });}
async function responsiveGeometry({screen,width,zoom,theme}){
 const geometry=await page.evaluate(()=>{
  const root=document.documentElement,inside=[],clipped=[];
  for(const node of document.querySelectorAll('a,button,input,select,textarea,[role="button"]')){
   const style=getComputedStyle(node),rect=node.getBoundingClientRect();
   if(style.display==='none'||style.visibility==='hidden'||rect.width===0||rect.height===0)continue;
   if(rect.left < -1 || rect.right > root.clientWidth+1)inside.push({tag:node.tagName.toLowerCase(),text:(node.innerText||node.getAttribute('aria-label')||'').trim().replace(/\s+/g,' ').slice(0,80),left:Math.round(rect.left*100)/100,right:Math.round(rect.right*100)/100});
   if(node.tagName==='BUTTON'&&node.scrollWidth>node.clientWidth+1)clipped.push({text:node.innerText,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth});
  }
  return {viewport:{innerWidth,devicePixelRatio,zoom:getComputedStyle(root).zoom,theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'},
   document:{clientWidth:root.clientWidth,scrollWidth:root.scrollWidth},interactiveOutside:inside,clippedButtons:clipped};
 });
 if(geometry.document.scrollWidth>width+1||geometry.interactiveOutside.length||geometry.clippedButtons.length){
  const report={screen,width,zoom,theme,geometry,details:await measureLayout(page)};
  const slug=`${screen}-${theme}-${width}-zoom${zoom}`.replace(/[^a-z0-9-]/gi,'-');
  const reportPath=resolve(evidence,`responsive-overflow-${slug}.json`);
  writeFileSync(reportPath,JSON.stringify(report,null,2));
  throw Error(`Unexpected horizontal overflow in ${screen}; DOM evidence: ${reportPath}; ${JSON.stringify(geometry)}`);
 }
 return geometry;
}
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
 browser=await({chromium,webkit}[browserName]).launch({headless:true});context=await browser.newContext({serviceWorkers:'block'});
 await context.tracing.start({screenshots:true,snapshots:true,sources:true});
 await context.route('**/*',route=>[base,new URL(local.API_URL).origin].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
 page=await context.newPage();page.on('response',async response=>{if(response.url().endsWith('/rpc/execute_client_mutation_v3')){const request=response.request().postDataJSON();if(request?.p_name==='update_my_profile')profileResponses.push({request,status:response.status(),body:await response.json().catch(()=>null)});}if(response.url().includes('/rpc/get_task_template_page_v2'))templateResponses.push({at:new Date().toISOString(),request:response.request().postDataJSON(),status:response.status(),body:await response.json().catch(()=>null)});});
 page.on('console',message=>browserEvents.push({at:new Date().toISOString(),type:message.type(),text:sanitize(message.text())}));
 page.on('pageerror',error=>browserEvents.push({at:new Date().toISOString(),type:'pageerror',text:sanitize(error.message)}));
 page.on('requestfailed',request=>browserEvents.push({at:new Date().toISOString(),type:'requestfailed',url:new URL(request.url()).pathname,error:request.failure()?.errorText}));
 await page.goto(base+'/login');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Пароль',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('heading',{name:'Проекты',exact:true}).waitFor();
 await check('P05 real project and stage progress geometry',async()=>{
  for(const width of [320,360,375,390,768,1280])for(const path of [`/projects/${project}/progress`,`/projects/${project}/tasks/${task}/progress`]){
   await page.setViewportSize({width,height:900});await page.goto(base+path);await page.getByText('Выполнен частично: 0% → 45%',{exact:true}).waitFor();
   await page.screenshot({path:resolve(evidence,`progress-${width}-${path.includes('/tasks/')?'task':'project'}.png`),fullPage:true});
   const measured=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('[data-testid="daily-progress-content"]')].some(n=>n.scrollWidth>n.clientWidth+1)}));
   const statusBox=await page.getByText('Выполнен частично: 0% → 45%',{exact:true}).boundingBox();
   measurements.push({width,path,...measured,statusBox});assert(measured.document<=width+1&&!measured.overflow&&statusBox&&statusBox.x>=0&&statusBox.x+statusBox.width<=width+1,'Clipped status: '+JSON.stringify({measured,statusBox}));
  }
 });
 await check('P05 exact dark 320px viewport and post-layout 200% CSS zoom reproduction',async()=>{
  await page.emulateMedia({colorScheme:'dark'});await page.setViewportSize({width:320,height:900});
  const path=`/projects/${project}/progress`;await page.goto(base+path);const status=page.getByText('Выполнен частично: 0% → 45%',{exact:true});await status.waitFor();
  await page.evaluate(()=>{document.documentElement.style.zoom='2';});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const geometry=await responsiveGeometry({screen:'project-progress-exact-css-zoom',width:320,zoom:2,theme:'dark'});
  const contentOverflow=await page.locator('[data-testid="daily-progress-content"]').evaluateAll(nodes=>nodes.some(node=>node.scrollWidth>node.clientWidth+1));
  const statusBox=await status.boundingBox();const result={width:320,zoom:2,theme:'dark',path,geometry,contentOverflow,statusBox};measurements.push(result);
  assert(!contentOverflow&&statusBox&&statusBox.x>=0&&statusBox.x+statusBox.width<=320+1,'Clipped exact P05 reproduction: '+JSON.stringify(result));
  await page.screenshot({path:resolve(evidence,'progress-exact-dark-320-css-zoom-200.png'),fullPage:true});
  await page.getByLabel('Обновить',{exact:true}).click({trial:true});
  await page.getByRole('link',{name:/^Уведомления/}).click({trial:true});
 });
 await check('P05 light/dark responsive matrix and 200% zoom preserve progress fields',async()=>{
  for(const theme of ['light','dark']){
   await page.emulateMedia({colorScheme:theme});
   for(const width of [320,360,375,390,768])for(const zoom of [1,2])for(const path of [`/projects/${project}/progress`,`/projects/${project}/tasks/${task}/progress`]){
    const effectiveWidth=Math.max(1,Math.floor(width/zoom));await page.setViewportSize({width:effectiveWidth,height:900});await page.goto(base+path);
    const status=page.getByText('Выполнен частично: 0% → 45%',{exact:true});await status.waitFor();
    await eventually(async()=>{const box=await status.boundingBox();return box&&box.x+box.width<=effectiveWidth+1;});
    const geometry=await responsiveGeometry({screen:path.includes('/tasks/')?'task-progress':'project-progress',width:effectiveWidth,zoom,theme});
    const contentOverflow=await page.locator('[data-testid="daily-progress-content"]').evaluateAll(nodes=>nodes.some(n=>n.scrollWidth>n.clientWidth+1));
    const statusBox=await status.boundingBox(),result={width,effectiveWidth,zoom,theme,path,geometry,contentOverflow,statusBox};measurements.push(result);
    assert(!contentOverflow&&statusBox&&statusBox.x>=0&&statusBox.x+statusBox.width<=effectiveWidth+1,'Clipped progress content: '+JSON.stringify(result));
    if(width===320||width===768)await page.screenshot({path:resolve(evidence,`progress-${theme}-${width}-zoom${zoom}-${path.includes('/tasks/')?'task':'project'}.png`),fullPage:true});
   }
  }
 });
 await check('P05 key screens, controls and dialogs fit the responsive viewport matrix',async()=>{
  const screens=[
   {name:'projects',path:'/projects',ready:()=>page.getByRole('heading',{name:'Проекты',exact:true})},
   {name:'project-and-stages',path:`/projects/${project}`,ready:()=>page.getByText('Stage geometry',{exact:true})},
   {name:'checklist',path:`/projects/${project}/tasks/${task}`,ready:()=>page.getByText('Чек-лист',{exact:true})},
   {name:'notifications',path:'/notifications',ready:()=>page.getByRole('heading',{name:'Уведомления',exact:true})},
   {name:'profile',path:'/profile',ready:()=>page.getByRole('heading',{name:'Профиль',exact:true})},
  ];
  for(const theme of ['light','dark']){
   await page.emulateMedia({colorScheme:theme});
   for(const width of [320,360,375,390,768])for(const zoom of [1,2]){
    const effectiveWidth=Math.max(1,Math.floor(width/zoom));await page.setViewportSize({width:effectiveWidth,height:900});
    for(const screen of screens){
     await page.goto(base+screen.path);await screen.ready().waitFor({state:'visible'});
     measurements.push({deviceWidth:width,effectiveWidth,zoom,screen:screen.name,...await responsiveGeometry({screen:screen.name,width:effectiveWidth,zoom,theme})});
    }
    await page.goto(base+`/projects/${project}`);await page.getByText('Stage geometry',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Архивировать проект',exact:true}).click();
    await page.getByLabel('Архивировать проект?',{exact:true}).waitFor({state:'visible'});
    measurements.push({deviceWidth:width,effectiveWidth,zoom,screen:'project-modal',...await responsiveGeometry({screen:'project-modal',width:effectiveWidth,zoom,theme})});
    if(width===320&&zoom===2)await page.screenshot({path:resolve(evidence,`project-modal-${theme}-${width}-zoom${zoom}.png`),fullPage:true});
    await page.getByRole('button',{name:'Отмена',exact:true}).click();
   }
  }
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
