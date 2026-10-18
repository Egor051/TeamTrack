// Actual exported app -> disposable Auth/Realtime/PostgREST -> isolated DB.
// Run through run-security-integrations.mjs; no hosted account or DB is used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';
import { stopSmokeServer } from './smoke-process-cleanup.mjs';
const require=createRequire(import.meta.url);
const { chromium }=require(process.env.TASKTRACE_PLAYWRIGHT_MODULE||'playwright');
const local=getLocalSupabaseStatus();
if(local.kind!=='tasktrace-isolated-security-test')throw Error('Disposable stack required');
const db=new pg.Client({connectionString:local.DB_URL});
const options={auth:{persistSession:false,autoRefreshToken:false}};
const admin=createClient(local.API_URL,local.SERVICE_ROLE_KEY,options);
const owner=createClient(local.API_URL,local.ANON_KEY,options);
const base='http://127.0.0.1:4178',password='AuditBrowserUnique9!';
const evidence=process.env.TASKTRACE_SECURITY_EVIDENCE||resolve('.expo/security-evidence');mkdirSync(evidence,{recursive:true});
let browser,server;
const users=[];
const measurements=[];
async function measure(page,label,action){
 const started=performance.now();let apiRequests=0;
 const count=request=>{if(request.url().startsWith(local.API_URL))apiRequests++;};
 page.on('request',count);
 try{await action();}finally{
  page.off('request',count);
  const memory=await page.evaluate(()=>performance.memory?.usedJSHeapSize??null).catch(()=>null);
  measurements.push({label,ms:Math.round(performance.now()-started),api_requests_started_in_window:apiRequests,js_heap_bytes:memory});
 }
}
const rpc=async(name,args)=>{const r=await owner.rpc(name,args);if(r.error)throw r.error;return r.data;};
async function eventually(probe,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await probe())return;await new Promise(r=>setTimeout(r,100));}throw Error('Browser timeout: '+label);}
async function login(page,email){await page.goto(base+'/login');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Пароль',{exact:true}).fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('heading',{name:'Проекты',exact:true}).waitFor();}
async function localState(page){return page.evaluate(async()=>{
 const db=await new Promise((ok,no)=>{const r=indexedDB.open('tasktrace-local-cache');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});
 try{const read=store=>new Promise((ok,no)=>{const r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});
 const entries=await read('entries'),operations=await read('pending_operations');
 return {operations,capabilities:entries.filter(e=>e.key==='runtime:offline-capabilities').map(e=>JSON.parse(e.data)),
  storage:{entries:entries.length,serialized_entry_bytes:new TextEncoder().encode(JSON.stringify(entries)).length,pending_operations:operations.length}};
 }finally{db.close();}
});}
try{
 await db.connect();await db.query('update private.offline_runtime_config set write_enabled=true,sync_enabled=true');
 for(const role of ['owner','member']){
  const email='audit-browser-'+role+'-'+process.pid+'@test.local';
  const r=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{display_name:'Audit Browser '+role}});
  if(r.error)throw r.error;users.push({id:r.data.user.id,email});
 }
 assert.equal((await owner.auth.signInWithPassword({email:users[0].email,password})).error,null);
 const projectA=await rpc('create_project',{p_name:'Browser project A',p_description:'Original description'});
 const projectB=await rpc('create_project',{p_name:'Browser project B'});
 for(const id of [projectA,projectB])await rpc('add_project_member',{p_project_id:id,p_user_id:users[1].id,p_role:'member'});
 const taskA=await rpc('create_task',{p_project_id:projectA,p_title:'Browser stage A'});
 const taskB=await rpc('create_task',{p_project_id:projectB,p_title:'Browser stage B'});
 const itemA=await rpc('create_task_item',{p_task_id:taskA,p_title:'Browser checklist A'});
 const itemB=await rpc('create_task_item',{p_task_id:taskB,p_title:'Browser checklist B'});
 await new Promise((ok,no)=>{const p=spawn(process.execPath,['scripts/build-phase6-local-smoke.mjs'],{stdio:'inherit',windowsHide:true});p.once('error',no);p.once('exit',c=>c===0?ok():no(Error('Browser export failed: '+c)));});
 server=spawn(process.execPath,['scripts/serve-web.mjs'],{env:{...process.env,PORT:'4178'},stdio:'ignore',windowsHide:true});
 await eventually(async()=>{try{return(await fetch(base)).ok;}catch{return false;}},'server');
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext();
 await context.route('**/*',route=>[base,new URL(local.API_URL).origin].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
 const errors=[];context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
 const page=await context.newPage();await measure(page,'cold app + login + project list',()=>login(page,users[0].email));
 await measure(page,'open project',async()=>{await page.goto(base+'/projects/'+projectA);await page.getByRole('button',{name:'Редактировать',exact:true}).waitFor();});
 await page.getByRole('button',{name:'Редактировать',exact:true}).click();
 const name=page.getByLabel('Название проекта',{exact:true});await name.fill('Local browser draft');
 await rpc('update_project',{p_project_id:projectA,p_name:'External project name',p_description:'External description'});
 await page.getByRole('button',{name:'Продолжить с моим черновиком',exact:true}).waitFor();
 assert.equal(await name.inputValue(),'Local browser draft');
 assert.equal(await page.getByLabel('Описание проекта',{exact:true}).inputValue(),'Original description');
 assert(await page.getByRole('button',{name:'Сохранить',exact:true}).isDisabled());
 await page.screenshot({path:resolve(evidence,'audit-project-draft-conflict.png')});
 await page.getByRole('button',{name:'Продолжить с моим черновиком',exact:true}).click();
 await page.getByRole('button',{name:'Сохранить',exact:true}).click();
 await page.getByRole('button',{name:'Редактировать',exact:true}).waitFor();
 assert.equal((await db.query('select name from public.projects where id=$1',[projectA])).rows[0].name,'Local browser draft');
 console.log('PASS B01 browser: real Broadcast refresh preserves draft, explicit conflict resolution, CAS save and rendered result');
 await context.close();
 const memberContext=await browser.newContext();
 await memberContext.route('**/*',route=>[base,new URL(local.API_URL).origin].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
 memberContext.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
 const a=await memberContext.newPage();await login(a,users[1].email);
 await measure(a,'open stage and checklist',async()=>{await a.goto(base+'/projects/'+projectA+'/tasks/'+taskA);await a.getByRole('checkbox').first().waitFor();});
 await a.evaluate(()=>navigator.serviceWorker.ready.then(()=>true));
 const b=await memberContext.newPage();await b.goto(base+'/projects/'+projectB+'/tasks/'+taskB);await b.getByRole('checkbox').first().waitFor();
 await eventually(async()=>/Синхронизация: подключено/.test(await b.locator('body').innerText()),'initial capability and cache');
 await eventually(async()=>(await localState(b)).capabilities.some(c=>c.value?.write_enabled&&c.value?.sync_enabled),'durable runtime confirmation');
 await memberContext.setOffline(true);
 await eventually(async()=>/Синхронизация: офлайн/.test(await a.locator('body').innerText()),'offline status');
 await measure(a,'offline checkbox durable enqueue',async()=>{await a.getByRole('checkbox').first().click();
  await eventually(async()=>(await localState(a)).operations.length===1,'first queued mutation');});
 await a.getByRole('checkbox').first().click();
 await eventually(async()=>(await localState(a)).operations.length===2,'dependent queued mutation');
 await b.getByRole('checkbox').first().click();
 await eventually(async()=>(await localState(b)).operations.length===3,'independent queued mutation');
 await rpc('remove_project_member',{p_project_id:projectA,p_user_id:users[1].id});
 await measure(b,'reconnect + independent replay despite revoked chain',async()=>{await memberContext.setOffline(false);
  await eventually(async()=>Number((await db.query('select percentage from public.task_items where id=$1',[itemB])).rows[0].percentage)===100,'independent project replay',45000);});
 await b.reload();await b.getByRole('checkbox').first().waitFor();
 await eventually(async()=>/Синхронизация: ошибка/.test(await b.locator('body').innerText()),'failed operation survives restart');
 await b.getByRole('button',{name:/Синхронизация: ошибка/}).first().click();
 await b.getByRole('button',{name:'Отправить изменение снова',exact:true}).click();
 await b.getByText('Повторить не удалось. Проверьте подключение и доступ к пункту.',{exact:true}).waitFor();
 b.once('dialog',dialog=>dialog.accept());
 await b.getByRole('button',{name:'Отменить локальное изменение',exact:true}).click();
 await eventually(async()=>!/несинхр/.test(await b.locator('body').innerText()),'cancel revoked dependency chain');
 assert.equal(Number((await db.query('select percentage from public.task_items where id=$1',[itemA])).rows[0].percentage),0);
 assert.equal(Number((await db.query('select percentage from public.task_items where id=$1',[itemB])).rows[0].percentage),100);
 await b.screenshot({path:resolve(evidence,'audit-revoked-queue-recovered.png')});
 assert.deepEqual(errors,[]);
 writeFileSync(resolve(evidence,'release-browser-performance.json'),JSON.stringify({environment:'current production export / disposable local services / headless Chromium',
  baseline_available:false,percent_change_not_claimed:true,network_counts:'request starts within each interaction window; background work may overlap',
  memory_scope:'Chromium JS heap sample, not native/process peak memory',measurements,final_cache:(await localState(b)).storage},null,2));
 writeFileSync(resolve(evidence,'audit-remediation-browser.json'),JSON.stringify({real_api:true,realtime_draft_preserved:true,cas_save:true,
   revoked_queue_independent_replay:true,failed_restart:true,retry_denied:true,local_cancel_without_access:true,dependent_chain_removed:true,uncaught_errors:errors},null,2));
 console.log('PASS B02 browser: real offline dependent chain, revocation/42501, independent replay, reload, retry denial and authorized local cancellation');
 await memberContext.close();
}catch(error){
 if(browser)for(const [i,context]of browser.contexts().entries())for(const [j,page]of context.pages().entries()){
  try{writeFileSync(resolve(evidence,`audit-browser-failure-${i}-${j}.json`),JSON.stringify({body:await page.locator('body').innerText(),state:await localState(page)},null,2));await page.screenshot({path:resolve(evidence,`audit-browser-failure-${i}-${j}.png`)});}catch{/* Page may have closed during the failing navigation. */}
 }
 throw error;
}finally{
 await browser?.close();await stopSmokeServer(server);owner.realtime.disconnect();admin.realtime.disconnect();
 await db.end().catch(()=>undefined);
}
