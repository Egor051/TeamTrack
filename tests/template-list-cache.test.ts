import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ rpc: vi.fn() }));
const template = '00000000-0000-4000-8000-000000000010';
vi.mock('@/lib/supabase/client', () => ({ supabase: { rpc: f.rpc, auth: { getSession: async () => ({
  data: { session: { user: { id: 'user' }, expires_at: Date.now()/1000+3600 } }, error: null,
}) } } }));
vi.mock('@/lib/local-cache/driver', async () => await import('@/lib/local-cache/driver.web'));
vi.mock('@/features/auth/auth', () => ({ getCurrentUser: vi.fn() }));
beforeEach(async () => {
  vi.resetModules(); f.rpc.mockReset(); vi.stubGlobal('navigator', { onLine: true });
  await new Promise<void>((resolve,reject) => { const r=indexedDB.deleteDatabase('tasktrace-local-cache'); r.onsuccess=()=>resolve(); r.onerror=()=>reject(r.error); });
  (await import('@/lib/local-cache/read-freshness')).setReadAccount('user');
});
afterEach(() => vi.unstubAllGlobals());
const rows = Array.from({ length: 1001 }, (_,n) => ({ id: String(n), template_position: n+1 }));
function pages() {
  f.rpc.mockImplementation(async (name: string, args: { p_offset?: number; p_limit?: number }) => {
    // The old table RPC really returns only 1000 rows. This regression must
    // fail if a caller reintroduces that path, even if the paginator still exists.
    if (name !== 'get_task_template_page_v2') return { data: rows.slice(0,1000), error: null };
    const offset=args.p_offset??0;
    return { data: { revision:'one',total:rows.length,offset,rows:rows.slice(offset,offset+(args.p_limit??500)) }, error:null };
  });
}
it('B03: real list entry points publish the complete catalog and items to the existing cache', async () => {
  pages(); const p=await import('@/features/projects/projects');
  expect(await p.listTaskTemplates()).toHaveLength(1001);
  const items=await p.listTaskTemplateItems(template); expect(items).toHaveLength(1001); expect(items[1000].position).toBe(1001);
  const driver=(await import('@/lib/local-cache/driver')).localCacheDriver;
  expect(JSON.parse((await driver.get('user','templates'))!.data)).toHaveLength(1001);
  expect(JSON.parse((await driver.get('user',`template-items:${template}`))!.data)).toHaveLength(1001);
});
it('B03: a later page failure cannot certify or store a partial list; an older complete snapshot stays intact', async () => {
  pages(); const p=await import('@/features/projects/projects');
  await p.listTaskTemplates();
  const driver=(await import('@/lib/local-cache/driver')).localCacheDriver;
  const before=await driver.get('user','templates');
  const r=await import('@/lib/local-cache/read-freshness');
  await r.invalidateReadModels('user',['templates'],'refresh');
  f.rpc.mockImplementation(async (_name: string, args: { p_offset: number }) => args.p_offset===0
    ? {data:{revision:'two',total:2001,offset:0,rows:rows.slice(0,500)},error:null}
    : {data:null,error:{code:'XX000',message:'second page failed'}});
  await expect(p.listTaskTemplates()).rejects.toMatchObject({ code:'XX000' });
  expect((await driver.get('user','templates'))?.data).toBe(before!.data);
  expect((await r.durableReadInvalidation('user','templates')).kind).toBe('refresh');
});
it('B03: without a previous snapshot, a failed later page leaves no list or freshness acknowledgement', async () => {
  f.rpc.mockImplementation(async (_name: string,args:{p_offset:number}) => args.p_offset===0
    ? {data:{revision:'one',total:1001,offset:0,rows:rows.slice(0,500)},error:null}
    : {data:null,error:{code:'XX000',message:'second page failed'}});
  await expect((await import('@/features/projects/projects')).listTaskTemplates()).rejects.toThrow();
  const driver=(await import('@/lib/local-cache/driver')).localCacheDriver;
  expect(await driver.get('user','templates')).toBeNull();
});
it.each(['templates',`template-items:${template}`])('B03 upgrade: a legacy capped %s snapshot cannot be returned as complete offline', async (key) => {
  const driver=(await import('@/lib/local-cache/driver')).localCacheDriver;
  await driver.put({user_id:'user',key,data:JSON.stringify(rows.slice(0,1000)),last_synced_at:new Date().toISOString(),schema_version:1});
  vi.stubGlobal('navigator',{onLine:false});
  const p=await import('@/features/projects/projects');
  await expect(key==='templates'?p.listTaskTemplates():p.listTaskTemplateItems(template)).rejects.toThrow();
  expect(f.rpc).not.toHaveBeenCalled();
});
it('B03 upgrade: online recovery replaces legacy data with all pages and the new version; reload then works offline', async () => {
  const driver=(await import('@/lib/local-cache/driver')).localCacheDriver;
  await driver.put({user_id:'user',key:'templates',data:JSON.stringify(rows.slice(0,1000)),last_synced_at:new Date().toISOString(),schema_version:1});
  pages(); const p=await import('@/features/projects/projects');
  expect(await p.listTaskTemplates()).toHaveLength(1001);
  expect((await driver.get('user','templates'))?.schema_version).toBe(2);
  vi.resetModules(); (await import('@/lib/local-cache/read-freshness')).setReadAccount('user');
  vi.stubGlobal('navigator',{onLine:false}); f.rpc.mockClear();
  expect(await (await import('@/features/projects/projects')).listTaskTemplates()).toHaveLength(1001);
  expect(f.rpc).not.toHaveBeenCalled();
});
it.each(['templates',`template-items:${template}`])('RA-04: Broadcast during a paginated %s read cannot certify an older response', async (key) => {
  pages(); const p=await import('@/features/projects/projects');
  const load=()=>key==='templates'?p.listTaskTemplates():p.listTaskTemplateItems(template);
  await load();
  const driver=(await import('@/lib/local-cache/driver')).localCacheDriver;
  const previous=(await driver.get('user',key))!.data;
  const r=await import('@/lib/local-cache/read-freshness');
  await r.invalidateReadModels('user',[key],'refresh');
  let events=0;
  f.rpc.mockImplementation(async (_name:string,args:{p_offset:number;p_limit:number})=>{
    if(args.p_offset===500) { events++; await r.invalidateRealtimeModels('user','task_template_items',{}); }
    return {data:{revision:'two',total:rows.length,offset:args.p_offset,
      rows:rows.slice(args.p_offset,args.p_offset+args.p_limit).map(row=>({...row,title:'New version'}))},error:null};
  });
  await load();
  expect(events).toBe(1);
  expect((await driver.get('user',key))!.data).toBe(previous);
  expect((await r.durableReadInvalidation('user',key)).kind).toBe('data');
  pages(); await load();
  expect(JSON.parse((await driver.get('user',key))!.data)).toHaveLength(1001);
  expect((await r.durableReadInvalidation('user',key)).kind).toBeNull();
});
