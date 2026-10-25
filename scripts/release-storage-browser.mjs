// Real IndexedDB + old JS supplied by a real service worker. Synthetic stores
// only; full lost-ACK/HTTP coverage lives in regression-mutation-browser.
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename,dirname,resolve } from 'node:path';
import { build } from 'vite';
import { chromium,webkit } from 'playwright';
const root=resolve(import.meta.dirname,'..');
const old=execFileSync('git',['show','810f1a367b7d350b5e3ce1bb0b62f22093ba9049:src/lib/local-cache/driver.web.ts'],{encoding:'utf8'});
const make=async legacy=>{
 const result=await build({configFile:false,logLevel:'silent',resolve:{alias:{'@':resolve(root,'src')}},plugins:[{
  name:'storage-compatibility-fixture',enforce:'pre',resolveId(id,importer){
   if(id==='entry'||id.replaceAll('\\','/').endsWith('/entry'))return '\0entry';if(id==='old-driver')return '\0old-driver.ts';
   if(importer==='\0old-driver.ts'&&id.startsWith('./'))return resolve(root,'src/lib/local-cache',id+'.ts');
  },load(id){if(id==='\0old-driver.ts')return old;if(id==='\0entry')return `import{localCacheDriver as d}from ${JSON.stringify(legacy?'old-driver':resolve(root,'src/lib/local-cache/driver.web.ts').replaceAll('\\','/'))};globalThis.driver=d;`;}
 }],build:{write:false,minify:false,lib:{entry:'entry',name:'StorageFixture',formats:['iife']}}});
 return (Array.isArray(result)?result[0]:result).output.find(row=>row.type==='chunk').code;
};
const bundles={old:await make(true),new:await make(false)};
let browser;const server=http.createServer((req,res)=>{
 if(req.url==='/sw.js') {
  res.setHeader('Content-Type','application/javascript');res.end("self.addEventListener('install',e=>e.waitUntil(caches.open('old-js').then(c=>c.add('/old.js')).then(()=>self.skipWaiting())));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/old.js')e.respondWith(caches.match(e.request));});");
 }else if(req.url.endsWith('.js')) {res.setHeader('Content-Type','application/javascript');res.end(req.url==='/old.js'?bundles.old:bundles.new);}
 else {res.setHeader('Content-Type','text/html');res.end('<!doctype html><script src="/'+(req.url==='/old'?'old':'new')+'.js"></script>');}
});
try {
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 browser=await(process.argv.includes('--webkit')?webkit:chromium).launch({headless:true});
 const context=await browser.newContext(),a=await context.newPage(),b=await context.newPage();
 await a.goto(url+'/old');await a.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;});
 await a.reload();await a.waitForFunction(()=>navigator.serviceWorker.controller!==null);
 await a.evaluate(async()=>{
  await driver.put({user_id:'u',key:'items:t:active',data:JSON.stringify([{id:'i',sync_version:10}]),schema_version:1,last_synced_at:''});
  await driver.enqueue({user_id:'u',operation_id:'legacy-queue',project_id:'p',task_id:'t',task_item_id:'i',protocol_version:2,type:'set_task_item_percentage',payload:{percentage:30},status:'pending',created_at:''});
 });
 await b.goto(url+'/new');await b.evaluate(async()=>{
  await driver.put({user_id:'u',key:'items:t:active',data:JSON.stringify([{id:'i',sync_version:10},{id:'j',sync_version:1}]),schema_version:1,last_synced_at:''});
  await driver.enqueue({user_id:'u',operation_id:'11111111-1111-8111-8111-111111111111',project_id:'p',task_id:'t',task_item_id:'j',expected_version:1,protocol_version:3,type:'set_task_item_percentage',payload:{percentage:60},status:'pending',created_at:''});
  const id='11111111-1111-8111-8111-111111111111';await driver.bindOperationHandle('u',id,{id,protocol_version:3,fingerprint_version:1,generation:'22222222-2222-4222-8222-222222222222',epoch:7,admit_until:'2030-01-02',replay_until:'2030-04-02'});
 });
 assert.equal((await a.evaluate(()=>driver.listPending('u'))).length,2);
 assert.ok(await a.evaluate(()=>driver.get('u','items:t:active')));
 await b.reload();const rows=await b.evaluate(()=>driver.listPending('u'));
 assert.equal(rows[0].protocol_version,2);assert.equal(rows[1].operation_handle.epoch,7);
 console.log('PASS F01 old SW JavaScript + new tab coexist on v5 with nonempty v2/v3 outbox and durable handles');
 // Simulate an unreleased installation that already opened v6. The compatible
 // artifact opens it without lowering/deleting it; original v5 is unsupported.
 await b.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('tasktrace-local-cache',6);r.onerror=()=>reject(r.error);r.onsuccess=()=>{r.result.close();resolve();};}));
 assert.equal((await b.evaluate(()=>driver.listPending('u'))).length,2);
 assert.equal(await a.evaluate(async()=>{try{await driver.get('u','items:t:active');return 'unsafe';}catch(e){return e.name;}}),'VersionError');
 await b.reload();assert.equal((await b.evaluate(()=>driver.listPending('u')))[1].operation_handle.epoch,7);
 console.log('PASS F01 compatible rollback/restart reads existing v6 without erasing or downgrading it');
 await context.close();
 // Upgrade from v2 with a live old connection, close that tab during upgrade,
 // then retry. An aborted/blocked attempt must leave the queue intact.
 const upgrade=await browser.newContext(),oldPage=await upgrade.newPage(),newPage=await upgrade.newPage();await oldPage.goto(url);
 await oldPage.evaluate(()=>new Promise((resolve,reject)=>{
  const r=indexedDB.open('tasktrace-local-cache',2);r.onupgradeneeded=()=>{
   const db=r.result;db.createObjectStore('entries');const s=db.createObjectStore('pending_operations',{keyPath:'sequence',autoIncrement:true});
   s.createIndex('by_operation_id','operation_id',{unique:true});s.createIndex('by_user','user_id');s.createIndex('by_user_task',['user_id','task_id']);
  };r.onerror=()=>reject(r.error);r.onsuccess=()=>{globalThis.blockingDb=r.result;const tx=r.result.transaction('pending_operations','readwrite');tx.objectStore('pending_operations').put({operation_id:'preserve',user_id:'u',protocol_version:2,status:'pending'});tx.oncomplete=()=>resolve();};
 }));
 await newPage.goto(url+'/new');await newPage.evaluate(()=>{globalThis.first=driver.listPending('u').then(()=>null,e=>e.message);});
 await oldPage.close();await newPage.evaluate(()=>globalThis.first);
 const preserved=await newPage.evaluate(()=>driver.listPending('u'));assert.equal(preserved.length,1);assert.equal(preserved[0].operation_id,'preserve');
 console.log('PASS F01 closing a blocking old tab during upgrade preserves the pending queue and permits retry');
 await upgrade.close();
 // A real browser process restart must retain the v5 cache and both protocol
 // versions. This profile belongs only to this test, never to the user.
 const profile=mkdtempSync(resolve(tmpdir(),'tasktrace-f06-browser-'));
 const engine=process.argv.includes('--webkit')?webkit:chromium;let persistent;
 try {
  persistent=await engine.launchPersistentContext(profile,{headless:true});let page=await persistent.newPage();await page.goto(url+'/new');
  await page.evaluate(async()=>{
   await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
   await driver.put({user_id:'restart-user',key:'items:restart-task:active',data:'[{"id":"i","sync_version":10,"percentage":30},{"id":"j","sync_version":1}]',schema_version:1,last_synced_at:''});
   for(const [id,protocol,item,version]of[['restart-v2',2,'i',10],['77777777-7777-8777-8777-777777777777',3,'j',1]])await driver.enqueue({user_id:'restart-user',operation_id:id,project_id:'p',task_id:'restart-task',task_item_id:item,expected_version:version,protocol_version:protocol,type:'set_task_item_percentage',payload:{percentage:40},status:'pending',created_at:''});
   const id='77777777-7777-8777-8777-777777777777';await driver.bindOperationHandle('restart-user',id,{id,protocol_version:3,fingerprint_version:1,generation:'22222222-2222-4222-8222-222222222222',epoch:7,admit_until:'2030-01-02',replay_until:'2030-04-02'});
  });
  const before=await page.evaluate(()=>driver.listPending('restart-user'));await persistent.close();persistent=null;
  persistent=await engine.launchPersistentContext(profile,{headless:true});page=await persistent.newPage();await page.goto(url+'/new');
  assert.deepEqual(await page.evaluate(()=>driver.listPending('restart-user')),before);
  assert.equal((await page.evaluate(()=>driver.get('restart-user','items:restart-task:active'))).data,'[{"id":"i","sync_version":10,"percentage":30},{"id":"j","sync_version":1}]');
  assert.equal(await page.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('tasktrace-local-cache');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const version=r.result.version;r.result.close();resolve(version);};})),5);
  console.log('PASS F06 actual browser process restart preserves IndexedDB v5, cached data, nonempty v2/v3 outbox and full handles');
 }finally{
  await persistent?.close();assert.equal(dirname(resolve(profile)),resolve(tmpdir()));assert.match(basename(profile),/^tasktrace-f06-browser-/);rmSync(profile,{recursive:true});
 }
}finally{await browser?.close();await new Promise(r=>server.close(r));}
