import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/local-cache/driver', async () => await import('@/lib/local-cache/driver.web'));
beforeEach(async () => {
  vi.resetModules();
  await new Promise<void>((resolve,reject)=>{const request=indexedDB.deleteDatabase('tasktrace-local-cache');request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);});
});
afterEach(()=>vi.restoreAllMocks());
it('REG-02: delayed IndexedDB open cannot write an ACL marker after the membership deadline', async () => {
  let release!:()=>void; const held=new Promise<void>(resolve=>{release=resolve;});
  const open=indexedDB.open.bind(indexedDB); let reached=false;
  vi.spyOn(indexedDB,'open').mockImplementation((...args)=>{
    const request=open(...args);
    return new Proxy(request,{set(target,key,value){
      if(key==='onsuccess')target.onsuccess=event=>{reached=true;void held.then(()=>value.call(target,event));};
      else Reflect.set(target,key,value);return true;
    },get:(target,key)=>{const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  });
  const {invalidateReadModels,readInvalidation}=await import('@/lib/local-cache/read-freshness');
  const controller=new AbortController();const result=invalidateReadModels('user',undefined,'access',controller.signal).catch(error=>error);
  await vi.waitFor(()=>expect(reached).toBe(true));controller.abort();release();await result;
  vi.restoreAllMocks();
  const {localCacheDriver}=await import('@/lib/local-cache/driver');
  expect(await localCacheDriver.listEntries('user')).toEqual([]);
  // A valid pre-deadline quarantine remains fail-closed in memory.
  expect(readInvalidation('user','projects:active').kind).toBe('access');
});
it('REG-02: cancelling an active ACL write aborts its real IndexedDB transaction', async () => {
  const {invalidateReadModels}=await import('@/lib/local-cache/read-freshness');
  const {localCacheDriver}=await import('@/lib/local-cache/driver');
  const controller=new AbortController(),put=IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype,'put').mockImplementationOnce(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){
    const request=put.apply(this,args);controller.abort();return request;
  });
  await expect(invalidateReadModels('user',undefined,'access',controller.signal)).rejects.toBeDefined();
  expect(await localCacheDriver.listEntries('user')).toEqual([]);
  expect(()=>invalidateReadModels('user',undefined,'access',controller.signal)).toThrow('Operation cancelled');
});

it('REG-UI: cancelling a guarded cache batch never leaks a late write exception or partial state', async () => {
  const {localCacheDriver:driver}=await import('@/lib/local-cache/driver.web');
  const entry=(key:string,data:string)=>({user_id:'user',key,data,last_synced_at:'',schema_version:1});
  await driver.put(entry('guard','owner'));await driver.put(entry('retained','old'));
  const controller=new AbortController(),put=IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){
    const request=put.apply(this,args);if(args[1]==='user:first')controller.abort();return request;
  });
  await expect(driver.withOperation!(controller.signal).commitCacheBatch('user',[entry('first','new'),entry('second','new')],['retained'],[{key:'guard',data:'owner'}])).rejects.toMatchObject({name:'AbortError'});
  vi.restoreAllMocks();
  expect(await driver.get('user','first')).toBeNull();expect(await driver.get('user','second')).toBeNull();expect((await driver.get('user','retained'))?.data).toBe('old');
});

it('REG-UI: a guarded batch write failure rejects with its cause and rolls back earlier queued writes', async () => {
  const {localCacheDriver:driver}=await import('@/lib/local-cache/driver.web');
  const entry=(key:string,data:string)=>({user_id:'user',key,data,last_synced_at:'',schema_version:1});
  await driver.put(entry('guard','owner'));await driver.put(entry('retained','old'));
  const put=IDBObjectStore.prototype.put,injected=new DOMException('Fixture write quota','QuotaExceededError');
  vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){
    if(args[1]==='user:second')throw injected;return put.apply(this,args);
  });
  await expect(driver.commitCacheBatch('user',[entry('first','new'),entry('second','new')],['retained'],[{key:'guard',data:'owner'}])).rejects.toBe(injected);
  vi.restoreAllMocks();
  expect(await driver.get('user','first')).toBeNull();expect(await driver.get('user','second')).toBeNull();expect((await driver.get('user','retained'))?.data).toBe('old');
});
