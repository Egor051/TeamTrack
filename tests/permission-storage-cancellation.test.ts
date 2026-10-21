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
