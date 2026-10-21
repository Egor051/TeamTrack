import { describe, expect, it, vi } from 'vitest';
import { readTemplatePages } from '@/features/projects/template-pages';

const data = (count: number) => Array.from({ length: count }, (_, id) => ({ id: String(id), title: `Item ${id}` }));
function source(rows: { id: string }[]) {
  return vi.fn(async (offset: number, limit: number, revision: string | null) => ({ error: null,
    data: { rows: rows.slice(offset, offset + limit), total: rows.length, revision: revision ?? 'revision-1', offset } }));
}
describe('B03 complete, consistent template pages', () => {
  it.each([0,1,999,1000,1001,2001,5001])('loads all %i rows in order without duplicates', async (count) => {
    const rows = data(count), request = source(rows);
    expect(await readTemplatePages(request)).toEqual(rows);
    expect(request).toHaveBeenCalledTimes(Math.max(1, Math.ceil(count / 500)));
    if (count > 500) expect(request).toHaveBeenNthCalledWith(2, 500, 500, 'revision-1', null);
  });
  it('restarts from page zero on concurrent insert/delete/edit; never mixes revisions', async () => {
    const old = data(1001), next = data(1002).reverse();
    const request = source(next);
    request.mockImplementationOnce(async () => ({ data: { rows: old.slice(0,500), total: old.length, offset: 0, revision: 'old' }, error: null }));
    request.mockImplementationOnce(async () => ({ data: null, error: { code: 'PT409', message: 'changed' } }) as never);
    expect(await readTemplatePages(request)).toEqual(next);
    expect(request.mock.calls.map((row) => row[0])).toEqual([0,500,0,500,1000]);
  });
  it('bounds continuous concurrent mutations and propagates a page network failure', async () => {
    const request = vi.fn(async () => ({ data: null, error: { code: 'PT409', message: 'changed' } }));
    await expect(readTemplatePages(request)).rejects.toMatchObject({ code: 'PT409' });
    expect(request).toHaveBeenCalledTimes(3);
    const broken = source(data(1001));
    broken.mockImplementationOnce(source(data(1001)));
    broken.mockImplementationOnce(async () => { throw new TypeError('Failed to fetch'); });
    await expect(readTemplatePages(broken)).rejects.toThrow('Failed to fetch');
    expect(broken).toHaveBeenCalledTimes(2);
  });
  it.each(['truncated','duplicate','offset','total','revision'])('rejects %s pages rather than returning a partial cache value', async (kind) => {
    const request = source(data(1001));
    request.mockImplementationOnce(source(data(1001)));
    request.mockImplementationOnce(async (offset, limit, revision) => {
      const page = { rows: data(1001).slice(offset,offset+limit), offset, total: 1001, revision: revision! };
      if (kind === 'truncated') page.rows.pop();
      if (kind === 'duplicate') page.rows[0] = { id: '0', title: 'duplicate' };
      if (kind === 'offset') page.offset = 0;
      if (kind === 'total') page.total = 1002;
      if (kind === 'revision') page.revision = 'wrong';
      return { data: page, error: null };
    });
    await expect(readTemplatePages(request)).rejects.toThrow();
  });
});
