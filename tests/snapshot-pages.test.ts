import { expect, it, vi } from 'vitest';
import { readSnapshotPages } from '@/lib/local-cache/snapshot-pages';

it.each(['delete', 'archive', 'reorder'])('BUG-02 retries a whole 501-item snapshot after concurrent %s', async () => {
  const initial = Array.from({ length: 501 }, (_, n) => ({ id: String(n + 1) }));
  const current = initial.slice(1);
  let calls = 0;
  const request = vi.fn(async (offset: number, revision: number | null) => {
    calls++;
    if (calls === 1) return { data: { revision: 1, total: 501, offset, rows: initial.slice(0, 500) }, error: null };
    if (revision === 1) return { data: null, error: { code: 'PT409' } };
    return { data: { revision: 2, total: 500, offset, rows: current.slice(offset, offset + 500) }, error: null };
  });
  const rows = await readSnapshotPages(request);
  expect(rows).toEqual(current); expect(rows.at(-1)?.id).toBe('501');
  expect(request.mock.calls.map(([offset]) => offset)).toEqual([0, 500, 0]);
});
it('never returns a partial or perpetually changing snapshot', async () => {
  await expect(readSnapshotPages(async () => ({ data: { revision: 1, total: 501, offset: 0, rows: [{ id: 'one' }] }, error: null }))).rejects.toThrow('incomplete');
  const request = vi.fn(async () => ({ data: null, error: { code: 'PT409' } }));
  await expect(readSnapshotPages(request)).rejects.toMatchObject({ code: 'PT409' });
  expect(request).toHaveBeenCalledTimes(3);
});
