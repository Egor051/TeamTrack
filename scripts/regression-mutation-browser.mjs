// Actual Chromium tabs: shared IndexedDB, native Web Locks and real PostgREST.
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';
import { createSecurityDatabase,root } from './security-test-harness.mjs';
import { startSecurityApi } from './security-test-api.mjs';
const env=await createSecurityDatabase();let api,browser,server;
const value=async q=>{const r=await q;if(r.error)throw r.error;return r.data;};
try{
 api=await startSecurityApi(env);const user=randomUUID();
 await env.db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{\"display_name\":\"Browser regression\"}')",[user,user+'@mutation.invalid']);
 const project=await value(api.client(user).rpc('create_project',{p_name:'Browser mutation regression'}));
 const stubs={
  'fixture-entry':`import {executeMutation} from ${JSON.stringify(resolve(root,'src/lib/supabase/mutation.ts').replaceAll('\\','/'))};globalThis.executeMutation=executeMutation;globalThis.calls=[];`,
  'fixture-client':`export const supabase={rpc(name,args){return{abortSignal:async signal=>{globalThis.calls.push(args.p_operation_id);const r=await fetch(globalThis.fixture.api+'/rpc/'+name,{method:'POST',signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+globalThis.fixture.token},body:JSON.stringify(args)});const data=await r.json();if(r.ok&&globalThis.dropAck){globalThis.dropAck=false;throw new TypeError('Failed to fetch');}if(r.ok)await globalThis.holdAck;return{data:r.ok?data:null,error:r.ok?null:data,status:r.status};}}}};`,
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
 server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'application/javascript':'text/html');res.end(req.url==='/bundle.js'?code:`<!doctype html><script>globalThis.fixture=${JSON.stringify({user,token:api.token(user),api:api.url})}</script><script src="/bundle.js"></script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});const context=await browser.newContext(),errors=[];
 context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
 const a=await context.newPage(),b=await context.newPage(),c=await context.newPage();await Promise.all([a.goto(url),b.goto(url),c.goto(url)]);
 const args=title=>({p_project_id:project,p_title:title});
 const launch=(page,input)=>page.evaluate(input=>{globalThis.result=globalThis.executeMutation('create_task',input).then(r=>({data:r.data,code:r.error?.code??null}),e=>({error:e.name}));},input);
 const result=page=>page.evaluate(()=>globalThis.result);
 const count=async title=>(await env.db.query('select count(*)::int n from public.tasks where project_id=$1 and title=$2',[project,title])).rows[0].n;
 const lost=async(title)=>{await a.evaluate(()=>{globalThis.dropAck=true;});await launch(a,args(title));assert.equal((await result(a)).error,'MutationOutcomeUnknownError');};
 const hold=()=>a.evaluate(()=>{globalThis.holdAck=new Promise(resolve=>{globalThis.releaseAck=resolve;});});
 const release=()=>a.evaluate(()=>{globalThis.releaseAck();globalThis.holdAck=null;});
 const queued=()=>b.waitForFunction(async()=> (await navigator.locks.query()).pending.some(lock=>lock.name.startsWith('tasktrace-mutation:')));
 await lost('two retries');await hold();await launch(a,args('two retries'));await a.waitForFunction(()=>globalThis.calls.length===2);
 await launch(b,args('two retries'));await queued();await release();assert.deepEqual(await result(a),await result(b));assert.equal(await count('two retries'),1);
 console.log('PASS REG-01 browser: two real tabs retry one lost committed ACK with one effect');
 await lost('deadline reload');await hold();await launch(a,args('deadline reload'));await a.waitForFunction(()=>globalThis.calls.length===4);
 await c.evaluate(user=>{globalThis.lockWait=navigator.locks.request('tasktrace-mutation:'+user,async()=>{globalThis.holding=true;await new Promise(resolve=>{globalThis.releaseLock=resolve;});});},user);
 await b.clock.install();await launch(b,args('deadline reload'));await queued();await release();await result(a);await c.waitForFunction(()=>globalThis.holding);
 await b.clock.fastForward(45_001);assert.equal((await result(b)).error,'TimeoutError');
 await b.reload();await c.evaluate(()=>globalThis.releaseLock());await launch(b,args('deadline reload'));assert.ok((await result(b)).data);assert.equal(await count('deadline reload'),1);
 console.log('PASS REG-01 browser: lock deadline + reload retain the ID after another tab retired the envelope');
 await hold();await launch(a,args('independent identical'));await a.waitForFunction(()=>globalThis.calls.length===5);
 await launch(b,args('independent identical'));await queued();await release();const [one,two]=await Promise.all([result(a),result(b)]);assert.notEqual(one.data,two.data);assert.equal(await count('independent identical'),2);
 console.log('PASS REG-01 browser: two independent identical intents produce two different receipts/effects');
 await lost('auth recovery');
 const rejected=async route=>{if(route.request().method()!=='POST')return route.continue();await route.fulfill({status:401,headers:{'content-type':'application/json','access-control-allow-origin':'*'},body:JSON.stringify({code:'PGRST301',message:'Synthetic expired authentication'})});};
 await a.route(api.url+'/rpc/execute_client_mutation',rejected);await launch(a,args('auth recovery'));assert.equal((await result(a)).code,'PGRST301');
 await a.unroute(api.url+'/rpc/execute_client_mutation',rejected);await launch(a,args('auth recovery'));assert.ok((await result(a)).data);assert.equal(await count('auth recovery'),1);
 assert.equal(await a.evaluate(()=>new Set(globalThis.calls.slice(-3)).size),1);
 console.log('PASS REG-01 browser: a denied retry preserves the committed ID through authentication recovery');
 await lost('closed tab');await a.close();await launch(b,args('closed tab'));assert.ok((await result(b)).data);assert.equal(await count('closed tab'),1);
 const abrupt=await context.newPage();await abrupt.goto(url);
 await abrupt.evaluate(()=>{globalThis.holdAck=new Promise(()=>{});});await launch(abrupt,args('abrupt close'));
 for(let attempt=0;attempt<100&&await count('abrupt close')!==1;attempt++)await new Promise(r=>setTimeout(r,20));
 assert.equal(await count('abrupt close'),1);const committedId=await abrupt.evaluate(()=>globalThis.calls.at(-1));
 await abrupt.close();await launch(b,args('abrupt close'));assert.ok((await result(b)).data);
 assert.equal(await b.evaluate(()=>globalThis.calls.at(-1)),committedId);assert.equal(await count('abrupt close'),1);
 console.log('PASS REG-01 browser: abrupt closure before ACK handling replays the orphaned running ID');
 const stale=await b.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('tasktrace-local-cache',5);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('entries'),get=tx.objectStore('entries').getAll();get.onsuccess=()=>resolve(get.result.filter(row=>row.key.startsWith('sync:mutation:')).length);tx.oncomplete=()=>db.close();};}));
 assert.equal(stale,0);assert.deepEqual(errors,[]);
 console.log('PASS REG-01 browser: tab closure recovery; zero stale envelopes, zero browser errors');
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));api?.close();await env.close();}
