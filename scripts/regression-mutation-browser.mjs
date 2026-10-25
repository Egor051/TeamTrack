// Actual Chromium tabs: shared IndexedDB, native Web Locks and real PostgREST.
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';
import { chromium, webkit } from 'playwright';
import { createSecurityDatabase,root } from './security-test-harness.mjs';
import { startSecurityApi } from './security-test-api.mjs';
const evidence=resolve('.expo','r03',new Date().toISOString().replaceAll(':','-')+'-'+process.pid);
mkdirSync(evidence,{recursive:true});
const events=[];let scenario='setup';
const trace=(event)=>events.push({scenario,hostMs:performance.now(),...event});
const env=await createSecurityDatabase();let api,browser,server,user,project,persistent;
const value=async q=>{const r=await q;if(r.error)throw r.error;return r.data;};
try{
 api=await startSecurityApi(env);user=randomUUID();
 await env.db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{\"display_name\":\"Browser regression\"}')",[user,user+'@mutation.invalid']);
 project=await value(api.client(user).rpc('create_project',{p_name:'Browser mutation regression'}));
 const stubs={
  'fixture-entry':`import {executeMutation} from ${JSON.stringify(resolve(process.env.TASKTRACE_MUTATION_SOURCE??resolve(root,'src/lib/supabase/mutation.ts')).replaceAll('\\','/'))};import{localCacheDriver}from'@/lib/local-cache/driver';globalThis.executeMutation=executeMutation;globalThis.mutationDriver=localCacheDriver;globalThis.calls=[];`,
  'fixture-client':`export const supabase={rpc(name,args={}){return{abortSignal:async signal=>{
    const id=args.p_operation_id,requestId=crypto.randomUUID();
    if((!id&&globalThis.stopBeforeContext)||(id&&globalThis.stopBeforeSend)){
      globalThis.blockedBeforeFetch=true;await globalThis.r03trace?.({event:'before-fetch-barrier',id,name});await new Promise(()=>{});
    }
    if(id)globalThis.calls.push(id);
    await globalThis.r03trace?.({event:'http-send',id,requestId,name,generation:args.p_generation,epoch:args.p_epoch,accountEpoch:1});
    const r=await fetch(globalThis.fixture.api+'/rpc/'+name,{method:'POST',signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+globalThis.fixture.token},body:JSON.stringify(args)});
    if(id&&globalThis.stopBeforeBody){globalThis.blockedBeforeBody=true;await globalThis.r03trace?.({event:'before-body-barrier',id,requestId,status:r.status});await new Promise(()=>{});}
    const data=await r.json();await globalThis.r03trace?.({event:'http-body',id,requestId,status:r.status});
    if(id&&r.ok&&globalThis.dropAck){globalThis.dropAck=false;await globalThis.r03trace?.({event:'lost-ack',id,requestId});throw new TypeError('Failed to fetch');}
    if(id&&r.ok&&globalThis.holdAck){globalThis.ackHeld=true;await globalThis.holdAck;globalThis.ackHeld=false;}
    return{data:r.ok?data:null,error:r.ok?null:data,status:r.status};
  }}}};`,
  'fixture-cache':`export const activeCacheUserId=async()=>globalThis.fixture.user;export const isTransportFailure=e=>/fetch|timeout/i.test(e?.message??'')||e?.name==='TimeoutError';`,
  'fixture-epoch':`export const readAccountEpoch=()=>1;`,
  'fixture-connectivity':`export const usesLocalReads=()=>false;`,
 };
 const bundled=await build({configFile:false,logLevel:'silent',resolve:{alias:{'@':resolve(root,'src')}},plugins:[{
  name:'isolated-mutation-fixture',enforce:'pre',
  resolveId(id,importer){
   const normalized=id.replaceAll('\\','/');
   if(id in stubs)return '\0'+id;
   if(normalized.endsWith('/fixture-entry'))return '\0fixture-entry';
   if(normalized.endsWith('/lib/local-cache/cache'))return '\0fixture-cache';
   if(normalized.endsWith('/lib/local-cache/read-freshness'))return '\0fixture-epoch';
   if(normalized.endsWith('/lib/connectivity/state'))return '\0fixture-connectivity';
   if(normalized.endsWith('/lib/local-cache/driver'))return resolve(root,'src/lib/local-cache/driver.web.ts');
   if(id==='./client'&&importer?.replaceAll('\\','/').endsWith('/supabase/mutation.ts'))return '\0fixture-client';
  },load(id){if(id.startsWith('\0'))return stubs[id.slice(1)];}
 }],build:{write:false,minify:false,lib:{entry:'fixture-entry',name:'MutationFixture',formats:['iife']}}});
 const output=Array.isArray(bundled)?bundled[0]:bundled;
 const code=output.output.find(row=>row.type==='chunk').code;
 server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'application/javascript; charset=utf-8':'text/html; charset=utf-8');res.end(req.url==='/bundle.js'?code:`<!doctype html><meta charset="utf-8"><script>globalThis.fixture=${JSON.stringify({user,token:api.token(user),api:api.url})}</script><script src="/bundle.js"></script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 browser=await (process.argv.includes('--webkit')?webkit:chromium).launch({headless:true});const context=await browser.newContext(),errors=[];
 const observe=async(context)=>{
   await context.exposeBinding('r03trace',(source,event)=>trace({tab:source.page?._guid,...event}));
   context.on('page',page=>{page.on('pageerror',error=>errors.push(error.message));page.on('close',()=>trace({event:'tab-closed'}));});
   await context.addInitScript(()=>{
     if(!navigator.locks)return; // about:blank has no secure-context APIs.
     const original=navigator.locks.request.bind(navigator.locks);
     const query=navigator.locks.query.bind(navigator.locks);
     navigator.locks.query=async()=>{const snapshot=await query();await globalThis.r03trace({event:'lock-snapshot',snapshot});return snapshot;};
     navigator.locks.request=(name,options,callback)=>{if(typeof options==='function'){callback=options;options={};}
       void globalThis.r03trace({event:'lock-request',name});
       return original(name,options,async lock=>{await globalThis.r03trace({event:'lock-granted',name});try{return await callback(lock);}finally{await globalThis.r03trace({event:'lock-released',name});}});};
     const set=Storage.prototype.setItem,remove=Storage.prototype.removeItem;
     Storage.prototype.setItem=function(key,value){const result=set.call(this,key,value);if(key.startsWith('tasktrace:mutation-retry:')){const v=JSON.parse(value);void globalThis.r03trace({event:'binding-saved',id:v.id,phase:v.phase,handle:v.handle});}return result;};
     Storage.prototype.removeItem=function(key){const result=remove.call(this,key);if(key.startsWith('tasktrace:mutation-retry:'))void globalThis.r03trace({event:'binding-removed'});return result;};
   });
 };
 await observe(context);
 let a=await context.newPage(),b=await context.newPage(),c=await context.newPage();await Promise.all([a.goto(url),b.goto(url),c.goto(url)]);
 const args=title=>({p_project_id:project,p_title:title});
 const launch=(page,input,mode)=>page.evaluate(({input,mode})=>{const error=e=>e&&({name:e.name,code:e.code,message:e.message,status:e.status,details:e.details,cause:error(e.cause)});globalThis.result=globalThis.executeMutation('create_task',input,{mode}).then(r=>({data:r.data,code:r.error?.code??null}),e=>({error:e.name,...error(e)}));},{input,mode});
 const result=page=>page.evaluate(()=>globalThis.result);
 const count=async title=>(await env.db.query('select count(*)::int n from public.tasks where project_id=$1 and title=$2',[project,title])).rows[0].n;
 const lost=async(title)=>{await a.evaluate(()=>{globalThis.dropAck=true;});await launch(a,args(title));const r=await result(a);assert.equal(r.error,'MutationOutcomeUnknownError',JSON.stringify(r));};
 const hold=()=>a.evaluate(()=>{globalThis.ackHeld=false;globalThis.holdAck=new Promise(resolve=>{globalThis.releaseAck=resolve;});});
 const release=()=>a.evaluate(()=>{globalThis.releaseAck();globalThis.holdAck=null;});
 const queued=()=>b.waitForFunction(async()=> (await navigator.locks.query()).pending.some(lock=>lock.name.startsWith('tasktrace-mutation:')));
 const committed=async(title)=>{await a.waitForFunction(()=>globalThis.ackHeld);assert.equal(await count(title),1);trace({event:'independent-sql-commit-visible',effects:1});};
 scenario='two retries';await lost('two retries');await hold();await launch(a,args('two retries'));await committed('two retries');
 await launch(b,args('two retries'),'retry');await queued();await release();assert.deepEqual(await result(a),await result(b));assert.equal(await count('two retries'),1);
 console.log('PASS REG-01 browser: two real tabs retry one lost committed ACK with one effect');
 const original={a,b,c},timed=await browser.newContext();await observe(timed);
 a=await timed.newPage();b=await timed.newPage();c=await timed.newPage();
 // Clock is context-wide. Install before navigation or any application timer.
 await b.clock.install();await Promise.all([a.goto(url),b.goto(url),c.goto(url)]);
 await b.evaluate(()=>{globalThis.clockFired=false;const timer=setTimeout(()=>{globalThis.clockFired=true;},50);clearTimeout(timer);});
 await b.clock.fastForward(100);assert.equal(await b.evaluate(()=>globalThis.clockFired),false);
 console.log('PASS Clock lifecycle: install precedes app timers and cancelled timers stay cancelled');
 scenario='deadline reload';await lost('deadline reload');await hold();await launch(a,args('deadline reload'));await committed('deadline reload');
 await c.evaluate(user=>{globalThis.lockWait=navigator.locks.request('tasktrace-mutation:'+user,async()=>{globalThis.holding=true;await new Promise(resolve=>{globalThis.releaseLock=resolve;});});},user);
 await launch(b,args('deadline reload'),'retry');await queued();await release();await result(a);await c.waitForFunction(()=>globalThis.holding);
 await b.clock.fastForward(45_001);assert.equal((await result(b)).error,'TimeoutError');
 await b.reload();await c.evaluate(async()=>{globalThis.releaseLock();await globalThis.lockWait;});await launch(b,args('deadline reload'));assert.ok((await result(b)).data);assert.equal(await count('deadline reload'),1);
 console.log('PASS REG-01 browser: lock deadline + reload retain the ID after another tab retired the envelope');
 await timed.close();({a,b,c}=original);
 scenario='independent identical';await hold();await launch(a,args('independent identical'));await committed('independent identical');
 await launch(b,args('independent identical'));await queued();await release();const [one,two]=await Promise.all([result(a),result(b)]);assert.notEqual(one.data,two.data);assert.equal(await count('independent identical'),2);
 console.log('PASS REG-01 browser: two independent identical intents produce two different receipts/effects');
 scenario='auth recovery';await lost('auth recovery');
 const rejected=async route=>{if(route.request().method()!=='POST')return route.continue();await route.fulfill({status:401,headers:{'content-type':'application/json','access-control-allow-origin':'*'},body:JSON.stringify({code:'PGRST301',message:'Synthetic expired authentication'})});};
 const mutationEndpoint=process.argv.includes('--expect-ambiguous-intent')?'execute_client_mutation':'execute_client_mutation_v3';
 await a.route(api.url+'/rpc/'+mutationEndpoint,rejected);await launch(a,args('auth recovery'));assert.equal((await result(a)).code,'PGRST301');
 await a.unroute(api.url+'/rpc/'+mutationEndpoint,rejected);await launch(a,args('auth recovery'));const recovered=await result(a);assert.ok(recovered.data,JSON.stringify(recovered));assert.equal(await count('auth recovery'),1);
 assert.equal(await a.evaluate(()=>new Set(globalThis.calls.slice(-3)).size),1);
 console.log('PASS REG-01 browser: a denied retry preserves the committed ID through authentication recovery');
 scenario='closed tab';await lost('closed tab');await a.close();await launch(b,args('closed tab'),'retry');const closedResult=await result(b);assert.ok(closedResult.data,JSON.stringify(closedResult));assert.equal(await count('closed tab'),1);
 const abrupt=await context.newPage();await abrupt.goto(url);
 await abrupt.evaluate(()=>{globalThis.holdAck=new Promise(()=>{});});await launch(abrupt,args('abrupt close'));
 for(let attempt=0;attempt<100&&await count('abrupt close')!==1;attempt++)await new Promise(r=>setTimeout(r,20));
 assert.equal(await count('abrupt close'),1);const committedId=await abrupt.evaluate(()=>globalThis.calls.at(-1));
 await abrupt.close();await launch(b,args('abrupt close'),'retry');assert.ok((await result(b)).data);
 assert.equal(await b.evaluate(()=>globalThis.calls.at(-1)),committedId);assert.equal(await count('abrupt close'),1);
 console.log('PASS REG-01 browser: abrupt closure before ACK handling replays the orphaned running ID');
 const intentContext=await browser.newContext();await observe(intentContext);
 a=await intentContext.newPage();b=await intentContext.newPage();c=await intentContext.newPage();await Promise.all([a.goto(url),b.goto(url),c.goto(url)]);
 scenario='unrelated account lock';await hold();await launch(a,args('unrelated lock'));await committed('unrelated lock');
 const orphanId=await a.evaluate(()=>globalThis.calls.at(-1));await a.close();
 await c.evaluate(user=>{globalThis.lockWait=navigator.locks.request('tasktrace-mutation:'+user,async()=>{globalThis.holding=true;await new Promise(r=>{globalThis.releaseLock=r;});});},user);
 await c.waitForFunction(()=>globalThis.holding);await launch(b,args('unrelated lock'),'retry');await queued();
 await c.evaluate(async()=>{globalThis.releaseLock();await globalThis.lockWait;});const intentResult=await result(b);
 if(process.argv.includes('--expect-ambiguous-intent')){assert.equal(intentResult.code,'TT_MUTATION_RECONCILED');console.log('BASELINE REPRODUCED: unrelated account lock misclassifies orphan retry');}
 else {assert.ok(intentResult.data,JSON.stringify(intentResult));console.log('PASS intent regression: unrelated account lock is not the owner of this operation');}
 assert.equal(await b.evaluate(()=>globalThis.calls.at(-1)),orphanId);assert.equal(await count('unrelated lock'),1);
 const stale=await b.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('tasktrace-local-cache',6);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('entries'),get=tx.objectStore('entries').getAll();get.onsuccess=()=>resolve(get.result.filter(row=>row.key.startsWith('sync:mutation:')).length);tx.oncomplete=()=>db.close();};}));
 assert.equal(stale,0);assert.deepEqual(errors,[]);
 if(!process.argv.includes('--expect-ambiguous-intent')){
   scenario='stale closing-tab lock snapshot';
   const staleContext=await browser.newContext();await observe(staleContext);
   a=await staleContext.newPage();b=await staleContext.newPage();await Promise.all([a.goto(url),b.goto(url)]);
   await hold();await launch(a,args(scenario));await committed(scenario);
   const closedId=await a.evaluate(()=>globalThis.calls.at(-1));await a.close();
   // Deterministic version of the real closing-tab failure captured in this
   // run: query's observed owner dies before the account fence is granted.
   await b.evaluate(({user,id})=>{const query=navigator.locks.query.bind(navigator.locks);navigator.locks.query=async()=>({...await query(),held:[{name:'tasktrace-mutation:'+user+':'+id,mode:'exclusive'}]});},{user,id:closedId});
   await launch(b,args(scenario),'retry');const staleResult=await result(b);assert.ok(staleResult.data,JSON.stringify(staleResult));
   assert.equal(await b.evaluate(()=>globalThis.calls.at(-1)),closedId);assert.equal(await count(scenario),1);await staleContext.close();
   console.log('PASS stale liveness snapshot: retained running intent is re-evaluated under the acquired account fence');
   const envelopes=page=>page.evaluate(()=>new Promise((resolve,reject)=>{const open=indexedDB.open('tasktrace-local-cache',6);open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('entries'),get=tx.objectStore('entries').getAll();get.onsuccess=()=>resolve(get.result.filter(row=>row.key.startsWith('sync:mutation:')).map(row=>JSON.parse(row.data)));tx.oncomplete=()=>db.close();};}));
   for(const point of ['context','send','body']){
     scenario='close-before-'+point;
     const fixture=await browser.newContext();await observe(fixture);
     a=await fixture.newPage();b=await fixture.newPage();await Promise.all([a.goto(url),b.goto(url)]);
     await a.evaluate(point=>{globalThis[point==='context'?'stopBeforeContext':point==='send'?'stopBeforeSend':'stopBeforeBody']=true;},point);
     await launch(a,args(scenario));await a.waitForFunction(point=>globalThis[point==='body'?'blockedBeforeBody':'blockedBeforeFetch'],point);
     const [saved]=await envelopes(b);assert.ok(saved?.id);assert.equal(Boolean(saved.handle),point!=='context');
     assert.equal(await count(scenario),point==='body'?1:0);
     trace({event:'durable-envelope-at-close',id:saved.id,handle:saved.handle,point});
     await a.close();await launch(b,args(scenario),'retry');assert.ok((await result(b)).data);
     assert.equal(await b.evaluate(()=>globalThis.calls.at(-1)),saved.id);assert.equal(await count(scenario),1);
     const receipt=(await env.db.query('select generation,epoch,completed_at from private.client_operation_receipts_v3 where user_id=$1 and operation_id=$2',[user,saved.id])).rows;
     assert.equal(receipt.length,1);assert.ok(receipt[0].completed_at);
     if(saved.handle){assert.equal(receipt[0].generation,saved.handle.generation);assert.equal(Number(receipt[0].epoch),saved.handle.epoch);}
     assert.equal((await envelopes(b)).length,0);await fixture.close();
   }
   console.log('PASS durable close barriers: before context fetch, after durable handle/before POST, after commit/before response body');
   for(const loss of ['idb','reinstall']){
     scenario='local-loss-'+loss;const fixture=await browser.newContext();await observe(fixture);
     a=await fixture.newPage();await a.goto(url);await lost(scenario);
     const oldId=await a.evaluate(()=>globalThis.calls.at(-1));await a.close();
     b=await fixture.newPage();await b.goto('about:blank');
     if(loss==='idb'){
       await b.goto(url);await b.evaluate(()=>new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase('tasktrace-local-cache');request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('Database deletion blocked'));}));
       await b.reload();
     }else {await fixture.close();const installed=await browser.newContext();await observe(installed);b=await installed.newPage();await b.goto(url);}
     await launch(b,args(scenario),'retry');assert.equal((await result(b)).code,'TT_OPERATION_HANDLE_MISSING');
     assert.deepEqual(await b.evaluate(()=>globalThis.calls),[]);assert.equal(await count(scenario),1);
     assert.equal((await env.db.query('select count(*)::int n from private.client_operation_receipts_v3 where user_id=$1 and operation_id=$2',[user,oldId])).rows[0].n,1);
     await b.context().close();
   }
   console.log('PASS lost storage and fresh installation: missing handle cannot silently become a new retry');
   scenario='independent device stores';
   const deviceA=await browser.newContext(),deviceB=await browser.newContext();await observe(deviceA);await observe(deviceB);
   a=await deviceA.newPage();b=await deviceB.newPage();await Promise.all([a.goto(url),b.goto(url)]);await lost(scenario);
   const [exported]=await envelopes(a);
   await b.evaluate(({user,project,exported})=>globalThis.mutationDriver.put({user_id:user,key:'sync:mutation:create_task:'+project,data:JSON.stringify(exported),schema_version:1,last_synced_at:''}),{user,project,exported});
   await Promise.all([launch(a,args(scenario),'retry'),launch(b,args(scenario),'retry')]);
   const devices=await Promise.all([result(a),result(b)]);assert.ok(devices[0].data);assert.deepEqual(devices[0],devices[1]);assert.equal(await count(scenario),1);
   assert.equal(await b.evaluate(()=>globalThis.calls.at(-1)),exported.id);await deviceA.close();await deviceB.close();
   console.log('PASS independent browser stores: a transferred full handle replays the same result without cross-device Web Locks');
   scenario='full browser restart';const engine=process.argv.includes('--webkit')?webkit:chromium,profile=resolve(evidence,'restart-profile');
   persistent=await engine.launchPersistentContext(profile,{headless:true});await observe(persistent);
   a=persistent.pages()[0]??await persistent.newPage();await a.goto(url);await lost(scenario);const restartId=await a.evaluate(()=>globalThis.calls.at(-1));
   await persistent.close();persistent=await engine.launchPersistentContext(profile,{headless:true});await observe(persistent);
   b=persistent.pages()[0]??await persistent.newPage();await b.goto(url);await launch(b,args(scenario),'retry');assert.ok((await result(b)).data);
   assert.equal(await b.evaluate(()=>globalThis.calls.at(-1)),restartId);assert.equal(await count(scenario),1);await persistent.close();persistent=null;
   console.log('PASS full browser process restart: IndexedDB preserves the original namespace and UUID');
 }
 scenario='F02 independent identical after unknown';
 {
   const independent=await browser.newContext();await observe(independent);
   a=await independent.newPage();b=await independent.newPage();await Promise.all([a.goto(url),b.goto(url)]);
   await lost(scenario);const oldId=await a.evaluate(()=>globalThis.calls.at(-1));
   await launch(b,args(scenario),'new');assert.equal((await result(b)).code,'TT_MUTATION_RECONCILED');
   assert.equal(await b.evaluate(()=>globalThis.calls.at(-1)),oldId);assert.equal(await count(scenario),1);
   await launch(b,args(scenario),'new');assert.ok((await result(b)).data);assert.equal(await count(scenario),2);
   assert.notEqual(await b.evaluate(()=>globalThis.calls.at(-1)),oldId);await independent.close();
   console.log('PASS F02 independent identical form after lost ACK reconciles the old effect without claiming its success; explicit next action gets its own ID');
 }
 const repeat=Number(process.argv.find(arg=>arg.startsWith('--repeat='))?.split('=')[1]??0);
 if(!Number.isInteger(repeat)||repeat<0||repeat>500)throw Error('Invalid fixed repeat count');
 for(let iteration=0;iteration<repeat;iteration++){
   for(const abrupt of [false,true]){
     scenario=`repeat-${iteration}-${abrupt?'running':'unknown'}`;
     const fixture=await browser.newContext();await observe(fixture);
     a=await fixture.newPage();b=await fixture.newPage();await Promise.all([a.goto(url),b.goto(url)]);
     const title=scenario;
     if(abrupt){await hold();await launch(a,args(title));await committed(title);}else await lost(title);
     const id=await a.evaluate(()=>globalThis.calls.at(-1));await a.close();await launch(b,args(title),'retry');const recovered=await result(b);
     assert.ok(recovered.data,JSON.stringify(recovered));assert.equal(await b.evaluate(()=>globalThis.calls.at(-1)),id);
     assert.equal(await count(title),1);
     assert.equal((await env.db.query('select count(*)::int n from private.client_operation_receipts_v3 where user_id=$1 and operation_id=$2',[user,id])).rows[0].n,1);
     assert.equal((await b.evaluate(()=>navigator.locks.query())).held.length,0);await fixture.close();
   }
 }
 if(repeat)console.log(`PASS fixed series: ${repeat} lost-ACK closures + ${repeat} running-orphan closures; zero automatic test retries`);
 console.log('PASS REG-01 browser: tab closure recovery; zero stale envelopes, zero browser errors');
}catch(error){
 trace({event:'failure',name:error.name,message:error.message,code:error.code,cause:String(error.cause??'')});
 const snapshots=[];
 for(const context of browser?.contexts()??[])for(const page of context.pages())snapshots.push(await page.evaluate(async()=>({locks:await navigator.locks.query(),bindings:Object.keys(sessionStorage).filter(k=>k.startsWith('tasktrace:mutation-retry:')).map(k=>{const v=JSON.parse(sessionStorage.getItem(k));return {id:v.id,phase:v.phase,handle:v.handle};}),envelopes:await new Promise((resolve,reject)=>{const open=indexedDB.open('tasktrace-local-cache');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result,tx=db.transaction('entries'),get=tx.objectStore('entries').getAll();get.onsuccess=()=>resolve(get.result.filter(row=>row.key.startsWith('sync:mutation:')));tx.oncomplete=()=>db.close();};})})).catch(e=>({error:e.message})));
 const receipts={legacy:(await env.db.query('select operation_id,completed_at from private.client_operation_receipts where user_id=$1',[user])).rows,
   v3:(await env.db.query('select generation,epoch,operation_id,encode(request_fingerprint,\'hex\') fingerprint,completed_at,outcome from private.client_operation_receipts_v3 where user_id=$1',[user])).rows};
 const effects=(await env.db.query('select count(*)::int n from public.tasks where project_id=$1',[project])).rows;
 writeFileSync(resolve(evidence,'failure.json'),JSON.stringify({snapshots,receipts,effects},null,2));throw error;
}finally{writeFileSync(resolve(evidence,'events.json'),JSON.stringify(events,null,2));await persistent?.close();await browser?.close();if(server)await new Promise(r=>server.close(r));api?.close();await env.close();}
