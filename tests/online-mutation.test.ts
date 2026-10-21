import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ user: 'account-a' as string | null, epoch: 1, rpc: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { rpc: f.rpc } }));
vi.mock('@/lib/local-cache/cache', () => ({ activeCacheUserId: async () => f.user,
  isTransportFailure: (e: { name?: string; message?: string }) => e?.name === 'TimeoutError' || /fetch|timeout/i.test(e?.message ?? '') }));
vi.mock('@/lib/local-cache/read-freshness', () => ({ readAccountEpoch: () => f.epoch }));
vi.mock('@/lib/local-cache/driver', async () => await import('@/lib/local-cache/driver.web'));
beforeEach(async () => {
  vi.useRealTimers(); vi.resetModules(); f.user = 'account-a'; f.epoch = 1; f.rpc.mockReset();
  await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase('tasktrace-local-cache'); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('BUG-05 replays the persisted operation after a committed response is lost and modules reload', async () => {
  const receipts = new Map<string, string>(); let effects = 0, loseAck = true;
  f.rpc.mockImplementation(async (_name, args) => {
    if (!receipts.has(args.p_operation_id)) { effects++; receipts.set(args.p_operation_id, 'created-project'); }
    if (loseAck) { loseAck = false; throw new TypeError('Failed to fetch'); }
    return { data: receipts.get(args.p_operation_id), error: null, status: 200 };
  });
  await expect((await import('@/lib/supabase/mutation')).executeMutation('create_project', { p_name: 'My project' })).rejects.toMatchObject({ name: 'MutationOutcomeUnknownError' });
  vi.resetModules();
  expect(await (await import('@/lib/supabase/mutation')).executeMutation('create_project', { p_name: 'My project' })).toMatchObject({ data: 'created-project' });
  expect(effects).toBe(1); expect(f.rpc.mock.calls[0][1].p_operation_id).toBe(f.rpc.mock.calls[1][1].p_operation_id);
  expect(await (await import('@/lib/local-cache/driver')).localCacheDriver.listEntries('account-a', 'sync:mutation:')).toEqual([]);
});
it('a changed form cannot silently create another object while the preceding result is unknown', async () => {
  f.rpc.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({ data: 'old-result', error: null, status: 200 });
  const { executeMutation } = await import('@/lib/supabase/mutation');
  await expect(executeMutation('create_project', { p_name: 'Original' })).rejects.toThrow();
  await expect(executeMutation('create_project', { p_name: 'Edited form' })).rejects.toMatchObject({ code: 'TT_MUTATION_RECONCILED' });
  expect(f.rpc.mock.calls[1][1].p_args).toEqual({ p_name: 'Original' });
  expect(f.rpc.mock.calls[1][1].p_operation_id).toBe(f.rpc.mock.calls[0][1].p_operation_id);
});
it.each([{status:401,code:'PGRST301'},{status:429,code:''},{status:403,code:'42501'}])('keeps the original unknown identity through a later Auth/gateway refusal ($status)', async ({status,code}) => {
  f.rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce({data:null,error:{message:'Request refused',code},status})
    .mockResolvedValue({data:'original committed result',error:null,status:200});
  const {executeMutation}=await import('@/lib/supabase/mutation');
  await expect(executeMutation('create_project',{p_name:'Original'})).rejects.toThrow();
  await expect(executeMutation('create_project',{p_name:'Original'})).resolves.toMatchObject({error:{code}});
  await expect(executeMutation('create_project',{p_name:'Original'})).resolves.toMatchObject({data:'original committed result'});
  expect(new Set(f.rpc.mock.calls.map(call=>call[1].p_operation_id)).size).toBe(1);
  expect(await (await import('@/lib/local-cache/driver')).localCacheDriver.listEntries('account-a','sync:mutation:')).toEqual([]);
});
it.each([408, 500, 0])('retains the operation after an ambiguous HTTP/parser result (%s)', async (status) => {
  f.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Unusable server response', code: '' }, status })
    .mockResolvedValue({ data: 'saved-result', error: null, status: 200 });
  const { executeMutation } = await import('@/lib/supabase/mutation');
  await expect(executeMutation('create_project', { p_name: 'Original' })).rejects.toMatchObject({ name: 'MutationOutcomeUnknownError' });
  expect(await (await import('@/lib/local-cache/driver')).localCacheDriver.listEntries('account-a', 'sync:mutation:')).toHaveLength(1);
  await expect(executeMutation('create_project', { p_name: 'Original' })).resolves.toMatchObject({ data: 'saved-result' });
  expect(f.rpc.mock.calls[1][1].p_operation_id).toBe(f.rpc.mock.calls[0][1].p_operation_id);
});
it('settles a request ignoring cancellation and retains its identity for a safe retry', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }); f.rpc.mockImplementation(() => new Promise(() => {}));
  const pending = (await import('@/lib/supabase/mutation')).executeMutation('create_project', { p_name: 'Pending' });
  const rejected = expect(pending).rejects.toMatchObject({ name: 'MutationOutcomeUnknownError' });
  // Allow IndexedDB's real task queue to write before advancing network time.
  await vi.waitFor(() => expect(f.rpc).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(20_000); await rejected;
  expect(await (await import('@/lib/local-cache/driver')).localCacheDriver.listEntries('account-a', 'sync:mutation:')).toHaveLength(1);
});
