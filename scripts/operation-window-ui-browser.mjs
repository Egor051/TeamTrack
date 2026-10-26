// Exported application, real Auth/PostgREST, real IndexedDB. Disposable stack only.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import http from 'node:http';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { chromium, webkit } from 'playwright';
import pg from 'pg';
import { getLocalSupabaseStatus } from './local-supabase-status.mjs';
import { stopSmokeServer } from './smoke-process-cleanup.mjs';
import { fixtureCas } from './fixture-cas.mjs';
import { expectedProviderDiagnostic } from './browser-error-evidence.mjs';

const local=getLocalSupabaseStatus();
assert.ok(process.env.TASKTRACE_ISOLATED_CONFIG && local.kind==='tasktrace-isolated-security-test'
 && /^\/teamtrack_audit_\d+$/.test(new URL(local.DB_URL).pathname)
 && [local.DB_URL,local.API_URL].every(url=>new URL(url).hostname==='127.0.0.1'));
const db=new pg.Client({connectionString:local.DB_URL}),auth={persistSession:false,autoRefreshToken:false};
const admin=createClient(local.API_URL,local.SERVICE_ROLE_KEY,{auth});let client;
const evidence=resolve('.expo','operation-window-ui',String(Date.now()));await mkdir(evidence,{recursive:true});
const value=async q=>{const r=await q;if(r.error)throw r.error;return r.data;};
const results=[],errors=[],providerErrors=[],sockets=new Set();let server,browser,persistent,proxy,dropOffline,dropConflictAck,terminalConflict,observePost=()=>{},proxyFailure;
const buildConfig=resolve(evidence,'isolated-build.json');
async function until(check,label){const deadline=Date.now()+45_000;while(Date.now()<deadline){if(proxyFailure)throw proxyFailure;if(await check())return;await new Promise(r=>setTimeout(r,50));}throw Error(label);}
async function retire(handle){
 const future=new Date(Date.parse(handle.replay_until)+1000).toISOString();
 await db.query("create or replace function private.operation_clock() returns timestamptz language sql volatile set search_path='' as $$ select '"+future+"'::timestamptz $$");
 try {await db.query('select private.run_client_operation_lifecycle(500)');}
 finally {await db.query("create or replace function private.operation_clock() returns timestamptz language sql volatile set search_path='' as $$ select clock_timestamp() $$");}
}
async function rows(page,store){return page.evaluate(store=>new Promise((ok,no)=>{const r=indexedDB.open('tasktrace-local-cache');r.onerror=()=>no(r.error);r.onsuccess=()=>{
 const db=r.result,tx=db.transaction(store),get=tx.objectStore(store).getAll();let result;
 get.onsuccess=()=>{result=get.result;};get.onerror=()=>no(get.error);
 // A successful request is not a finished transaction. Await its completion
 // before asserting stored state or deliberately tearing down this context.
 tx.oncomplete=()=>{db.close();ok(result);};
 tx.onabort=tx.onerror=()=>{db.close();no(tx.error??new Error('Fixture read transaction failed'));};
 };}),store);}
try{
 await db.connect();await db.query('update private.offline_runtime_config set write_enabled=true,sync_enabled=true');
 // Fault injection lives at the HTTP server boundary. WebKit service-worker
 // requests can bypass page.route, so page-level interception is insufficient.
 const upstreamUrl=new URL(local.API_URL);
 proxy=http.createServer((request,response)=>{
  const chunks=[];request.on('data',part=>chunks.push(part));request.on('end',async()=>{try{
   const body=Buffer.concat(chunks),path=new URL(request.url,'http://fixture').pathname;
   const mutation=/\/rpc\/(execute_client_mutation_v3|apply_task_item_state_operation_v3)$/.test(path);
   const args=mutation?JSON.parse(body.toString()):null;if(args)observePost(args);
   if(terminalConflict&&path.endsWith('/apply_task_item_state_operation_v3'))await terminalConflict(args);
   const lose=path.endsWith('/apply_task_item_state_operation_v3')?(dropConflictAck??dropOffline):null;
   if(lose&&lose===dropOffline)dropOffline=null;
   const upstream=http.request({hostname:upstreamUrl.hostname,port:upstreamUrl.port,path:request.url,method:request.method,
    headers:{...request.headers,host:upstreamUrl.host}},incoming=>{
    if(!lose){response.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(response);return;}
    // Deliver headers before cutting the committed body. Closing an entirely
    // empty reused socket permits browser-level retransmission of the POST,
    // which would count transport retransmits as application retry attempts.
    const headers={...incoming.headers};delete headers['content-length'];delete headers['transfer-encoding'];delete headers['content-encoding'];
    response.writeHead(incoming.statusCode,{...headers,'content-length':'1000000'});response.flushHeaders();
    incoming.resume();incoming.on('end',()=>{void lose(args,incoming.statusCode).catch(error=>{proxyFailure=error;}).finally(()=>response.destroy());});
   });upstream.on('error',()=>response.destroy());upstream.end(body);
  }catch(error){proxyFailure=error;response.destroy();}
  });
 });
 proxy.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 proxy.on('upgrade',(request,socket,head)=>{
  const upstream=http.request({hostname:upstreamUrl.hostname,port:upstreamUrl.port,path:request.url,headers:{...request.headers,host:upstreamUrl.host}});
  upstream.on('upgrade',(response,remote,remoteHead)=>{
   socket.write('HTTP/1.1 '+response.statusCode+' '+response.statusMessage+'\r\n'+Object.entries(response.headers).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');
   if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head);socket.pipe(remote).pipe(socket);
   socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());
  });upstream.on('error',()=>socket.destroy());upstream.end();
 });
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const proxyOrigin='http://127.0.0.1:'+proxy.address().port;
 await writeFile(buildConfig,JSON.stringify({...local,API_URL:proxyOrigin}),{mode:0o600});
 const build=spawn(process.execPath,['scripts/build-phase6-local-smoke.mjs'],{stdio:'inherit',windowsHide:true,env:{...process.env,TASKTRACE_ISOLATED_CONFIG:buildConfig}});
 await new Promise((ok,no)=>{build.on('error',no);build.on('exit',code=>code===0?ok():no(Error('Application export failed')));});
 server=spawn(process.execPath,['scripts/serve-web.mjs'],{env:{...process.env,PORT:'4187'},stdio:'ignore',windowsHide:true});
 const origin='http://127.0.0.1:4187';await until(async()=>{try{return(await fetch(origin)).ok;}catch{return false;}},'Static server unavailable');
 for(const [engine,type,width,theme] of [['chromium',chromium,1200,'light'],['webkit',webkit,390,'dark']]){
  // Each engine has its own account and profile, including its retained review
  // drafts. One engine's extra fixtures must not alter the other's bootstrap.
  client=createClient(local.API_URL,local.ANON_KEY,{auth});
  const email=`window-ui-${engine}-${Date.now()}@test.local`,password='WindowUiFixture#123';
  const {user}=await value(admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{display_name:'Window review fixture'}}));
  const {session}=await value(client.auth.signInWithPassword({email,password}));
  const profile=resolve(evidence,engine+'-synthetic-profile');let context,page,phase='active';
  const closeContext=async()=>{phase='intentional context teardown';try{await context.close();}finally{phase='closed';}};
  const setupPage=async()=>{
   phase='active';
   await context.exposeBinding('tasktraceUnhandledError',(source,event)=>errors.push({engine,phase,url:source.page.url(),at:new Date().toISOString(),...event}));
   await context.addInitScript(()=>{
    addEventListener('error',event=>{void globalThis.tasktraceUnhandledError({kind:'error',message:event.message,stack:event.error?.stack??null});});
    addEventListener('unhandledrejection',event=>{void globalThis.tasktraceUnhandledError({kind:'unhandledrejection',message:String(event.reason?.message??event.reason),stack:event.reason?.stack??null});});
   });
   await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort('internetdisconnected'));
   await context.addInitScript(({session,theme,origin})=>{if(location.origin!==origin)return;localStorage.setItem('sb-127-auth-token',JSON.stringify(session));localStorage.setItem('tasktrace.theme',theme);},{session,theme,origin});
   page=context.pages()[0]??await context.newPage();await page.bringToFront();
   assert.equal(await page.evaluate(()=>document.visibilityState),'visible');
   page.on('pageerror',error=>{
    const record={engine,phase,url:page.url(),at:new Date().toISOString(),name:error.name,message:error.message,stack:error.stack};
    providerErrors.push(record);
    if(!expectedProviderDiagnostic(record,proxyOrigin))errors.push(record);
   });
  };
  const openProfile=async()=>{
   context=persistent=await type.launchPersistentContext(profile,{headless:true,viewport:{width,height:900}});browser=context.browser();await setupPage();
  };
  // Retain the existing PWA acceptance in its original context type. The
  // additional process-restart cases below use an independent persistent profile.
  browser=await type.launch({headless:true});context=await browser.newContext({viewport:{width,height:900}});await setupPage();
  const posted=[];observePost=args=>posted.push(args);
  const args={p_name:`Saved review draft ${engine}`},id=randomUUID(),handle={...await value(client.rpc('get_client_operation_context')),id};
  const project=await value(client.rpc('execute_client_mutation_v3',{p_generation:handle.generation,p_epoch:handle.epoch,p_operation_id:id,p_name:'create_project',p_args:args}));
  await value(fixtureCas(client,'update_project',{p_project_id:project,p_name:`Current server project ${engine}`,p_description:null}));
  const task=await value(client.rpc('create_task',{p_project_id:project,p_title:'Expired outbox stage'}));
  const item=await value(client.rpc('create_task_item',{p_task_id:task,p_title:'Expired durable change'}));
  await retire(handle);
  await page.goto(origin+'/projects');await page.getByText(`Current server project ${engine}`,{exact:true}).waitFor();
  // Do not interrupt the initial bootstrap with the fixture's reload: its
  // unfinished lease would otherwise outlive this page and delay readiness.
  await page.getByText('Офлайн: готово',{exact:true}).waitFor();
  const key='sync:mutation:create_project:self',mutation={id,name:'create_project',args,phase:'review',protocol_version:3,handle,review_reason:'TT_OPERATION_EXPIRED'};
  await page.evaluate(({user,key,mutation})=>new Promise((ok,no)=>{const r=indexedDB.open('tasktrace-local-cache');r.onerror=()=>no(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('entries','readwrite');tx.objectStore('entries').put({user_id:user,key,data:JSON.stringify(mutation),schema_version:1,last_synced_at:new Date().toISOString()},user+':'+key);tx.oncomplete=()=>{db.close();ok();};tx.onerror=()=>no(tx.error);tx.onabort=()=>no(tx.error);};}),{user:user.id,key,mutation});
  await page.reload();await page.getByRole('button',{name:'Синхронизация: требуется согласование',exact:true}).click();
  await page.getByText(`Ваш черновик: Название: ${args.p_name}`,{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Повторить прежнюю отправку',exact:true}).count(),0);
  await page.getByRole('button',{name:'Получить актуальное состояние',exact:true}).click();
  await page.getByText(`Current server project ${engine}`,{exact:true}).last().waitFor();
  await page.getByRole('button',{name:'Я сверил данные, закрыть уведомление',exact:true}).waitFor();
  await page.screenshot({path:resolve(evidence,`${engine}-online-${theme}.png`),fullPage:true});
  await page.getByRole('button',{name:'Я сверил данные, закрыть уведомление',exact:true}).click();
  await until(async()=>!(await rows(page,'entries')).some(row=>row.key===key),'Online acknowledgement retained envelope');
  assert.equal(posted.length,0,'Review must never execute the expired command');
  assert.equal((await db.query('select count(*)::int n from public.projects where id=$1',[project])).rows[0].n,1);
  results.push({engine,case:'online expired review',theme,width,result:'PASS',handle});console.log('PASS '+engine+' online expired review: saved draft, fresh RLS read, explicit acknowledgement, no POST');

  await page.getByText('Офлайн: готово',{exact:true}).waitFor();
  let committedHandle;
  dropOffline=async(sent,status)=>{
   assert.equal(status,200);
   committedHandle={generation:sent.p_generation,epoch:sent.p_epoch,id:sent.p_operation_id,
    replay_until:(await db.query('select replay_until from private.client_operation_epochs where generation=$1 and epoch=$2',[sent.p_generation,sent.p_epoch])).rows[0].replay_until.toISOString()};
   await retire(committedHandle);
  };
  await page.goto(origin+`/projects/${project}/tasks/${task}`);
  const checkbox=page.getByRole('checkbox',{name:/Expired durable change/});await checkbox.waitFor();
  await context.setOffline(true);
  await until(async()=>(await page.locator('body').innerText()).includes('Синхронизация: офлайн'),'Offline status missing');
  await checkbox.click();await until(async()=>(await rows(page,'pending_operations')).length===1,'Offline draft not durable');
  const op=(await rows(page,'pending_operations'))[0];await context.setOffline(false);
  await until(async()=>(await rows(page,'pending_operations')).some(row=>row.status==='review'),'Expired outbox did not enter review');
  const saved=(await rows(page,'pending_operations'))[0];assert.equal(saved.operation_id,op.operation_id);assert.equal(saved.operation_handle.generation,committedHandle.generation);
  assert.equal(Number(saved.operation_handle.epoch),Number(committedHandle.epoch));
  await page.getByRole('button',{name:/Синхронизация: требуется согласование/}).click();
  await page.getByText('Ваш черновик: Выполнено',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Получить актуальное состояние',exact:true}).click();
  await page.getByText('На сервере: 100% · Без комментария',{exact:true}).waitFor();
  await page.screenshot({path:resolve(evidence,`${engine}-offline-${theme}.png`),fullPage:true});
  await page.getByRole('button',{name:'Оставить серверное и убрать черновик',exact:true}).click();
  await until(async()=>(await rows(page,'pending_operations')).length===0,'Explicit keep-server did not reconcile outbox');
  assert.equal((await db.query('select sync_version::int version from public.task_items where id=$1',[item])).rows[0].version,2);
  assert.equal(new Set(posted.filter(row=>row.p_operation_id===op.operation_id).map(row=>row.p_operation_id)).size,1);
  assert.equal((await db.query('select count(*)::int n from private.client_operation_receipts_v3 where operation_id=$1',[op.operation_id])).rows[0].n,0);
  results.push({engine,case:'offline lost ACK past expiry',theme,width,result:'PASS',handle:committedHandle});console.log('PASS '+engine+' expired offline outbox: original handle retained, no duplicate effect, explicit keep-server');
  await closeContext();await browser.close();browser=null;await openProfile();
  await page.goto(origin+'/projects');await page.getByText(`Current server project ${engine}`,{exact:true}).waitFor();
  await until(async()=>(await rows(page,'entries')).some(row=>{
   if(row.user_id!==user.id||row.key!=='runtime:offline-capabilities')return false;
   const value=JSON.parse(row.data);return value.value?.write_enabled===true&&value.value?.sync_enabled===true&&Date.now()-value.fetched_at<60_000;
  }),'Fresh profile has not obtained server-authorized offline capabilities');

  // N02: a real conflict is rebased once, all three replies are lost AFTER
  // PostgREST commits, and a completely restarted browser recovers that handle.
  const recoveryItem=await value(client.rpc('create_task_item',{p_task_id:task,p_title:'N02 conflict recovery'}));
  const taskUrl=origin+`/projects/${project}/tasks/${task}`;
  await page.goto(taskUrl);await page.getByRole('checkbox',{name:/N02 conflict recovery/}).waitFor();
  await until(async()=>(await rows(page,'entries')).some(row=>row.key===`items:${task}:active`
   && JSON.parse(row.data).some(item=>item.id===recoveryItem&&Number.isSafeInteger(item.sync_version))),'Recovery confirmed item cache not ready');
  await context.setOffline(true);
  await until(async()=>(await page.locator('body').innerText()).includes('Синхронизация: офлайн'),'N02 offline missing');
  await page.getByRole('checkbox',{name:/N02 conflict recovery/}).click();
  await until(async()=>(await rows(page,'pending_operations')).some(row=>row.task_item_id===recoveryItem),'N02 draft missing');
  await value(fixtureCas(client,'set_task_item_percentage',{p_task_item_id:recoveryItem,p_percentage:40}));
  await context.setOffline(false);
  await page.getByRole('button',{name:'Оставить моё',exact:true}).waitFor();
  const conflicting=(await rows(page,'pending_operations')).find(row=>row.task_item_id===recoveryItem);
  assert.equal(conflicting.status,'conflict');assert.ok(conflicting.operation_handle);
  let lostReplies=0;const conflictPosts=[];
  dropConflictAck=async(sent,status)=>{
   assert.equal(sent.p_task_item_id,recoveryItem);assert.equal(status,200);assert.ok(++lostReplies<=3,'Unexpected fourth lost-ACK POST');conflictPosts.push(sent);
  };
  await page.getByRole('button',{name:'Оставить моё',exact:true}).click();
  await until(async()=>lostReplies===3&&await page.getByRole('button',{name:'Оставить моё',exact:true}).isEnabled(),'N02 recovery action did not settle');
  const unknown=(await rows(page,'pending_operations')).find(row=>row.task_item_id===recoveryItem);
  assert.equal(unknown.status,'pending');assert.notEqual(unknown.operation_id,conflicting.operation_id);
  assert.ok(conflictPosts.every(row=>row.p_operation_id===unknown.operation_id&&row.p_generation===unknown.operation_handle.generation&&row.p_epoch===unknown.operation_handle.epoch));
  assert.equal((await db.query('select sync_version::int version from public.task_items where id=$1',[recoveryItem])).rows[0].version,3);
  dropConflictAck=null;
  await closeContext();persistent=null;browser=null;await openProfile();
  await page.goto(taskUrl);await page.getByRole('button',{name:'Оставить моё',exact:true}).waitFor();
  assert.deepEqual((await rows(page,'pending_operations')).find(row=>row.task_item_id===recoveryItem).operation_handle,unknown.operation_handle);
  const beforeRetry=posted.length;
  await page.getByRole('button',{name:'Оставить моё',exact:true}).click();
  await until(async()=>!(await rows(page,'pending_operations')).some(row=>row.task_item_id===recoveryItem)
   &&(await rows(page,'sync_conflicts')).length===0,'N02 replay did not reconcile and finish its conflict');
  await until(async()=>await page.getByRole('button',{name:'Оставить моё',exact:true}).count()===0,'N02 resolved conflict remained visible');
  assert.ok(posted.slice(beforeRetry).some(row=>row.p_operation_id===unknown.operation_id));
  assert.ok(posted.slice(beforeRetry).every(row=>row.p_operation_id===unknown.operation_id));
  assert.equal((await rows(page,'sync_conflicts')).length,0);
  assert.equal((await db.query('select sync_version::int version from public.task_items where id=$1',[recoveryItem])).rows[0].version,3);
  assert.equal((await db.query('select count(*)::int n from private.client_operation_receipts_v3 where user_id=$1 and target_id=$2',[user.id,recoveryItem])).rows[0].n,2);
  const beforeNew=posted.length;
  await page.getByRole('checkbox',{name:/N02 conflict recovery/}).click();
  await until(async()=>(await db.query('select sync_version::int version from public.task_items where id=$1',[recoveryItem])).rows[0].version===4,'N02 independent intent missing');
  assert.ok(posted.slice(beforeNew).every(row=>row.p_operation_id!==unknown.operation_id));
  results.push({engine,case:'N02 conflict lost all ACKs and browser restart',result:'PASS',handle:unknown.operation_handle,lostReplies});
  console.log('PASS '+engine+' N02: confirmed conflict, three lost committed ACKs, persistent browser restart, exact old handle replay, one effect, separate new intent');

  // N01: retire the bound rebased context immediately before its first POST.
  // Both the dependent draft and independent work must survive the transition.
  const terminalItem=await value(client.rpc('create_task_item',{p_task_id:task,p_title:'N01 terminal conflict'}));
  const independentItem=await value(client.rpc('create_task_item',{p_task_id:task,p_title:'N01 independent work'}));
  await until(async()=>(await rows(page,'pending_operations')).length===0,'Prior new intent not reconciled');
  await page.goto(taskUrl);await page.getByRole('checkbox',{name:/N01 independent work/}).waitFor();
  await context.setOffline(true);
  await until(async()=>(await page.locator('body').innerText()).includes('Синхронизация: офлайн'),'N01 offline missing');
  await page.getByRole('checkbox',{name:/N01 terminal conflict/}).click();
  await until(async()=>(await rows(page,'pending_operations')).filter(row=>row.task_item_id===terminalItem).length===1,'N01 first draft missing');
  await page.getByRole('checkbox',{name:/N01 terminal conflict/}).click();
  await page.getByRole('checkbox',{name:/N01 independent work/}).click();
  await until(async()=>(await rows(page,'pending_operations')).length===3,'N01 dependent and independent drafts missing');
  const drafts=await rows(page,'pending_operations'),dependent=drafts.filter(row=>row.task_item_id===terminalItem)[1];
  await value(fixtureCas(client,'set_task_item_percentage',{p_task_item_id:terminalItem,p_percentage:40}));
  await context.setOffline(false);await page.getByRole('button',{name:'Оставить моё',exact:true}).waitFor();
  let terminalPosts=0,terminalSent;
  terminalConflict=async sent=>{
   if(sent.p_task_item_id!==terminalItem)return;
   assert.equal(++terminalPosts,1,'Terminal conflict was posted again');terminalSent=sent;
   const epoch=(await db.query('select replay_until from private.client_operation_epochs where generation=$1 and epoch=$2',[sent.p_generation,sent.p_epoch])).rows[0];
   await retire({generation:sent.p_generation,epoch:sent.p_epoch,replay_until:epoch.replay_until.toISOString()});
  };
  await page.getByRole('button',{name:'Оставить моё',exact:true}).click();
  await until(async()=>(await rows(page,'pending_operations')).some(row=>row.task_item_id===terminalItem&&row.status==='review'),'N01 terminal review missing');
  await until(async()=>!(await rows(page,'pending_operations')).some(row=>row.task_item_id===independentItem),'N01 independent work blocked by terminal conflict');
  assert.equal(terminalPosts,1);assert.equal((await rows(page,'sync_conflicts')).length,0);
  const retained=(await rows(page,'pending_operations')).filter(row=>row.task_item_id===terminalItem);
  assert.equal(retained.length,2);assert.equal(retained[0].status,'review');assert.equal(retained[0].operation_id,terminalSent.p_operation_id);
  assert.equal(retained[0].operation_handle.generation,terminalSent.p_generation);assert.equal(retained[0].operation_handle.epoch,terminalSent.p_epoch);
  assert.equal(retained[1].operation_id,dependent.operation_id);assert.equal(retained[1].depends_on_operation_id,retained[0].operation_id);assert.equal(retained[1].status,'pending');
  await page.reload();await page.getByRole('button',{name:/^Синхронизация: требуется согласование/}).waitFor();
  await page.getByRole('button',{name:/^Синхронизация: требуется согласование/}).click();
  await page.getByRole('button',{name:'Получить актуальное состояние',exact:true}).click();
  await page.getByText('На сервере: 40% · Без комментария',{exact:true}).waitFor();
  assert.equal(terminalPosts,1);assert.deepEqual((await rows(page,'pending_operations')).filter(row=>row.task_item_id===terminalItem),retained);
  assert.equal((await db.query('select sync_version::int version from public.task_items where id=$1',[terminalItem])).rows[0].version,2);
  results.push({engine,case:'N01 terminal conflict with dependent and independent work',result:'PASS',terminalPosts,handle:retained[0].operation_handle});
  console.log('PASS '+engine+' N01: one terminal POST, promise settles, gate released, dependent draft retained, independent work commits, reload/read-only review');
  const profileReadiness=await page.evaluate(async()=>({
   registrations:(await navigator.serviceWorker.getRegistrations()).map(reg=>({active:reg.active?.state??null,waiting:reg.waiting?.state??null})),
   caches:await caches.keys(),
   assets:await Promise.all(['/offline-shell.html','/manifest.webmanifest','/icons/icon-192.png','/icons/icon-512.png','/favicon.ico',...Array.from(document.scripts).map(s=>s.src).filter(s=>s.includes('/_expo/static/'))]
    .map(async path=>({path,cached:!!await caches.match(path,{ignoreSearch:true})}))),
  }));
  results.push({engine,case:'persistent profile asset diagnostics; separate from conflict acceptance',observation:profileReadiness});
  terminalConflict=null;
  await closeContext();persistent=null;browser=null;
 }
 assert.deepEqual(errors,[]);
}catch(error){
 const pages=[];for(const context of browser?.contexts()??[])for(const page of context.pages()){
  pages.push({url:page.url(),body:await page.locator('body').innerText().catch(()=>''),operations:await rows(page,'pending_operations').catch(e=>({error:e.message})),
   runtime:await rows(page,'entries').then(rows=>rows.filter(row=>/bootstrap:metadata|runtime:|sync:/.test(row.key))).catch(e=>({error:e.message}))});
  await page.screenshot({path:resolve(evidence,'failure-'+pages.length+'.png'),fullPage:true}).catch(()=>undefined);
 }
 await writeFile(resolve(evidence,'failure.json'),JSON.stringify({error:error.message,pages,errors,providerErrors},null,2));throw error;
}finally{await writeFile(resolve(evidence,'results.json'),JSON.stringify({results,errors,providerErrors},null,2));await persistent?.close();await browser?.close();await stopSmokeServer(server);for(const socket of sockets)socket.destroy();if(proxy)await new Promise(r=>proxy.close(r));await unlink(buildConfig).catch(error=>{if(error.code!=='ENOENT')throw error;});await db.end();}
