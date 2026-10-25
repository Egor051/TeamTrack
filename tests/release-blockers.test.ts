import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { rpc: (name: string, args: unknown) => name === 'get_client_operation_context'
  ? Promise.resolve({ data: { protocol_version: 3, fingerprint_version: 1, generation: '11111111-1111-4111-8111-111111111111', epoch: 1,
    admit_until: '2030-01-02', replay_until: '2030-04-02' }, error: null }) : f.rpc(name, args) } }));
vi.mock('@/lib/local-cache/cache', () => ({ activeCacheUserId: async () => 'account', isTransportFailure: (e: Error) => /fetch/.test(e.message) }));
vi.mock('@/lib/local-cache/read-freshness', () => ({ readAccountEpoch: () => 1 }));
vi.mock('@/lib/local-cache/driver', async () => import('@/lib/local-cache/driver.web'));
beforeEach(async () => {
  vi.resetModules(); f.rpc.mockReset();
  await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase('tasktrace-local-cache'); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
});

it('F01 keeps an unmodified v5 opener usable after new storage writes', async () => {
  const { localCacheDriver: d } = await import('@/lib/local-cache/driver');
  await d.put({ user_id: 'account', key: 'sentinel', data: 'preserved', last_synced_at: '', schema_version: 1 });
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('tasktrace-local-cache', 5); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  db.close(); expect((await d.get('account', 'sentinel'))?.data).toBe('preserved');
});

it('F02 an unbound independent form cannot succeed with an earlier identical unknown result', async () => {
  const { localCacheDriver: d } = await import('@/lib/local-cache/driver');
  const id = '22222222-2222-4222-8222-222222222222';
  await d.put({ user_id: 'account', key: 'sync:mutation:create_project:self', data: JSON.stringify({ id, name: 'create_project', args: { p_name: 'Same' }, phase: 'unknown' }), last_synced_at: '', schema_version: 1 });
  f.rpc.mockResolvedValue({ data: 'previous-project', error: null, status: 200 });
  await expect((await import('@/lib/supabase/mutation')).executeMutation('create_project', { p_name: 'Same' }))
    .rejects.toMatchObject({ code: 'TT_MUTATION_RECONCILED' });
  expect(f.rpc).toHaveBeenCalledOnce(); expect(f.rpc.mock.calls[0][1].p_operation_id).toBe(id);
});

it('F01 v3 unknown envelopes cannot be read by the old online mutation key', async () => {
  f.rpc.mockRejectedValue(new TypeError('Failed to fetch'));
  await expect((await import('@/lib/supabase/mutation')).executeMutation('create_project', { p_name: 'Keep' })).rejects.toThrow();
  const { localCacheDriver: d } = await import('@/lib/local-cache/driver');
  expect(await d.get('account', 'sync:mutation:create_project:self')).toBeNull();
  const rows = await d.listEntries('account', 'sync:mutation:');
  expect(rows).toHaveLength(1); expect(JSON.parse(rows[0].data)).toMatchObject({ phase: 'unknown', handle: { protocol_version: 3 } });
});
