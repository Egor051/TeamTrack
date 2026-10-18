type Page = { revision: string; total: number; offset: number; rows: { id: string }[] };
type Response = { data: unknown; error: { code?: string; message: string } | null };
const PAGE_SIZE = 500;

export async function readTemplatePages<T extends { id: string }>(request: (offset: number, limit: number, revision: string | null) => PromiseLike<Response>): Promise<T[]> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rows: T[] = [], ids = new Set<string>();
    let revision: string | null = null, total: number | null = null;
    try {
      do {
        const response = await request(rows.length, PAGE_SIZE, revision);
        if (response.error) throw response.error;
        const page = response.data as Page | null;
        if (!page || !Array.isArray(page.rows) || !Number.isSafeInteger(page.total) || page.total < 0
          || page.offset !== rows.length || typeof page.revision !== 'string' || !page.revision
          || (revision !== null && page.revision !== revision) || (total !== null && page.total !== total)
          || page.rows.length !== Math.min(PAGE_SIZE, page.total - rows.length))
          throw new Error('Не удалось получить полный список шаблонов. Обновите данные.');
        revision = page.revision; total = page.total;
        for (const row of page.rows) {
          if (!row || typeof row.id !== 'string' || ids.has(row.id)) throw new Error('Некорректная страница шаблонов.');
          ids.add(row.id); rows.push(row as T);
        }
      } while (rows.length < total!);
      return rows;
    } catch (error) {
      if ((error as { code?: string })?.code !== 'PT409' || attempt === 2) throw error;
    }
  }
  throw new Error('Шаблоны продолжают изменяться. Повторите загрузку.');
}
