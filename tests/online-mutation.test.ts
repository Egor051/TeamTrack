import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ user: 'account-a' as string | null, epoch: 1, rpc: vi.fn(), contextError: null as null | { code: string; message: string } }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { rpc: (name: string, args: unknown) => name === 'get_client_operation_context'
  ? Promise.resolve(f.contextError ? { data: null, error: f.contextError } : { data: { protocol_version: 3, fingerprint_version: 1, generation: '11111111-1111-4111-8111-111111111111', epoch: 1,
    admit_until: '2030-01-02T00:00:00Z', replay_until: '2030-04-02T00:00:00Z' }, error: null }) : f.rpc(name, args) } }));
vi.mock('@/lib/local-cache/cache', () => ({ activeCacheUserId: async () => f.user,
  isTransportFailure: (e: { name?: string; message?: string }) => e?.name === 'TimeoutError' || /fetch|timeout/i.test(e?.message ?? '') }));
vi.mock('@/lib/local-cache/read-freshness', () => ({ readAccountEpoch: () => f.epoch }));
vi.mock('@/lib/local-cache/driver', async () => await import('@/lib/local-cache/driver.web'));
beforeEach(async () => {
  vi.useRealTimers(); vi.resetModules(); f.user = 'account-a'; f.epoch = 1; f.rpc.mockReset(); f.contextError = null;
  await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase('tasktrace-local-cache'); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('v3 full handle is durable before POST and survives a lost ACK with the same namespace', async () => {
  let lose = true;
  f.rpc.mockImplementation(async (name, args) => {
    expect(name).toBe('execute_client_mutation_v3');
    const entries = await (await import('@/lib/local-cache/driver')).localCacheDriver.listEntries('account-a','sync:mutation:');
    const saved = JSON.parse(entries[0].data);
    expect(saved.handle).toMatchObject({ id: args.p_operation_id, generation: args.p_generation, epoch: args.p_epoch, protocol_version: 3 });
    if (lose) { lose = false; throw new TypeError('Failed to fetch'); }
    return { data: 'committed', error: null, status: 200 };
  });
  const { executeMutation } = await import('@/lib/supabase/mutation');
  await expect(executeMutation('create_project',{ p_name: 'same' })).rejects.toThrow();
  await expect(executeMutation('create_project',{ p_name: 'same' },{mode:'retry'})).resolves.toMatchObject({data:'committed'});
  expect(f.rpc.mock.calls[0][1]).toEqual(f.rpc.mock.calls[1][1]);
});
it('expired outcome preserves the draft and refuses ordinary automatic replay', async () => {
  f.rpc.mockResolvedValue({ data: null, error: { code: 'TT_OPERATION_EXPIRED', details: 'TT_OPERATION_EXPIRED', message: 'Expired' }, status: 410 });
  const { executeMutation } = await import('@/lib/supabase/mutation');
  await expect(executeMutation('create_project',{p_name:'Keep draft'})).rejects.toMatchObject({code:'TT_OPERATION_EXPIRED'});
  await expect(executeMutation('create_project',{p_name:'Keep draft'})).rejects.toMatchObject({code:'TT_OPERATION_EXPIRED'});
  expect(f.rpc).toHaveBeenCalledOnce();
  const saved = JSON.parse((await (await import('@/lib/local-cache/driver')).localCacheDriver.listEntries('account-a','sync:mutation:'))[0].data);
  expect(saved).toMatchObject({ phase:'review', args:{p_name:'Keep draft'}, handle:{protocol_version:3} });
});
it('lost storage cannot turn an explicit retry into a fresh server command', async () => {
  await expect((await import('@/lib/supabase/mutation')).executeMutation('create_project',{p_name:'Lost'}, {mode:'retry'}))
    .rejects.toMatchObject({code:'TT_OPERATION_HANDLE_MISSING'});
  expect(f.rpc).not.toHaveBeenCalled();
});
it('a retained tab review restores a missing shared envelope without sending or minting a new attempt', async () => {
  const { localCacheDriver } = await import('@/lib/local-cache/driver');
  const saved = { id: 'a1111111-1111-4111-8111-111111111111', name: 'create_project', args: { p_name: 'Keep review' },
    protocol_version: 3, phase: 'review', review_reason: 'TT_OPERATION_EXPIRED', handle: {
      id: 'a1111111-1111-4111-8111-111111111111', protocol_version: 3, fingerprint_version: 1,
      generation: '11111111-1111-4111-8111-111111111111', epoch: 1, admit_until: '2030-01-02', replay_until: '2030-04-02' } };
  const key = 'sync:mutation:v3:create_project:self', values = new Map([['tasktrace:mutation-retry:account-a:'+key, JSON.stringify(saved)]]);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  const { executeMutation } = await import('@/lib/supabase/mutation');
  await expect(executeMutation('create_project', { p_name: 'Keep review' })).rejects.toMatchObject({ code: 'TT_OPERATION_EXPIRED' });
  expect(JSON.parse((await localCacheDriver.get('account-a', key))!.data)).toEqual(saved);
  expect(f.rpc).not.toHaveBeenCalled();
  const newer = { ...saved, id: 'b2222222-2222-4222-8222-222222222222', phase: 'unknown',
    handle: { ...saved.handle, id: 'b2222222-2222-4222-8222-222222222222' } };
  await localCacheDriver.put({ user_id:'account-a',key,data:JSON.stringify(newer),schema_version:1,last_synced_at:'' });
  await expect(executeMutation('create_project', { p_name: 'Keep review' })).rejects.toMatchObject({ code: 'TT_OPERATION_EXPIRED' });
  expect(JSON.parse((await localCacheDriver.get('account-a', key))!.data)).toEqual(newer);
  expect(f.rpc).not.toHaveBeenCalled();
});

it('failed context admission leaves a never-sent draft reusable with its original UUID after reload', async () => {
  f.contextError = { code: 'PT503', message: 'Configure operation windows' };
  await expect((await import('@/lib/supabase/mutation')).executeMutation('create_project',{p_name:'Not sent'})).rejects.toMatchObject({code:'PT503'});
  expect(f.rpc).not.toHaveBeenCalled();
  const before = JSON.parse((await (await import('@/lib/local-cache/driver')).localCacheDriver.listEntries('account-a','sync:mutation:'))[0].data);
  expect(before).toMatchObject({phase:'unknown',protocol_version:3});expect(before.handle).toBeUndefined();
  f.contextError = null;vi.resetModules();f.rpc.mockResolvedValue({data:'created',error:null,status:200});
  await expect((await import('@/lib/supabase/mutation')).executeMutation('create_project',{p_name:'Not sent'}, { mode: 'retry' })).resolves.toMatchObject({data:'created'});
  expect(f.rpc.mock.calls[0][1].p_operation_id).toBe(before.id);
});
it('BUG-05 replays the persisted operation after a committed response is lost and modules reload', async () => {
  const receipts = new Map<string, string>(); let effects = 0, loseAck = true;
  f.rpc.mockImplementation(async (_name, args) => {
    if (!receipts.has(args.p_operation_id)) { effects++; receipts.set(args.p_operation_id, 'created-project'); }
    if (loseAck) { loseAck = false; throw new TypeError('Failed to fetch'); }
    return { data: receipts.get(args.p_operation_id), error: null, status: 200 };
  });
  await expect((await import('@/lib/supabase/mutation')).executeMutation('create_project', { p_name: 'My project' })).rejects.toMatchObject({ name: 'MutationOutcomeUnknownError' });
  vi.resetModules();
  expect(await (await import('@/lib/supabase/mutation')).executeMutation('create_project', { p_name: 'My project' }, { mode: 'retry' })).toMatchObject({ data: 'created-project' });
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
it.each([
  { code: 'PT507', details: 'TT_RECEIPT_LIMIT', status: 507 },
  { code: 'PT413', details: 'TT_RECEIPT_LIMIT', status: 413 },
  { code: 'PT429', details: 'TT_RECEIPT_RATE', status: 429 },
  { code: 'PT503', details: 'TT_RECEIPT_POLICY', status: 503 },
])('retains a quota-blocked intent and UUID across module reload ($code)', async ({ code, details, status }) => {
  f.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Admission refused', code, details }, status })
    .mockResolvedValue({ data: 'saved-after-capacity-returns', error: null, status: 200 });
  await expect((await import('@/lib/supabase/mutation')).executeMutation('create_project', { p_name: 'Pending quota' }))
    .resolves.toMatchObject({ error: { code, details } });
  expect(await (await import('@/lib/local-cache/driver')).localCacheDriver.listEntries('account-a', 'sync:mutation:')).toHaveLength(1);
  vi.resetModules();
  await expect((await import('@/lib/supabase/mutation')).executeMutation('create_project', { p_name: 'Pending quota' }, { mode: 'retry' }))
    .resolves.toMatchObject({ data: 'saved-after-capacity-returns' });
  expect(f.rpc.mock.calls[0][1].p_operation_id).toBe(f.rpc.mock.calls[1][1].p_operation_id);
  expect(await (await import('@/lib/local-cache/driver')).localCacheDriver.listEntries('account-a', 'sync:mutation:')).toEqual([]);
});
it('retires a definitive member lookup denial so a separate action gets a new UUID', async () => {
  f.rpc.mockResolvedValue({ data: null, error: { code: 'TT_MEMBER_LOOKUP', message: 'Denied' }, status: 400 });
  const { executeMutation } = await import('@/lib/supabase/mutation');
  const args = { p_project_id: 'project', p_identifier: 'unknown', p_role: 'member' as const };
  await expect(executeMutation('add_project_member_by_identifier', args)).resolves.toMatchObject({ error: { code: 'TT_MEMBER_LOOKUP' } });
  await executeMutation('add_project_member_by_identifier', args);
  expect(f.rpc.mock.calls[0][1].p_operation_id).not.toBe(f.rpc.mock.calls[1][1].p_operation_id);
});
