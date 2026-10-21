type SnapshotPage<T> = { revision: number; total: number; offset: number; rows: T[] };

/** Publish only a complete server revision; discard every page on PT409. */
export async function readSnapshotPages<T extends { id: string }>(
  request: (offset: number, revision: number | null) => PromiseLike<{ data: unknown; error: { code?: string } | null }>,
): Promise<T[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows: T[] = [], ids = new Set<string>();
    let revision: number | null = null, total: number | null = null;
    try {
      do {
        const response = await request(rows.length, revision);
        if (response.error) throw response.error;
        const page = response.data as SnapshotPage<T> | null;
        if (!page || !Number.isSafeInteger(page.revision) || page.revision < 0
          || !Number.isSafeInteger(page.total) || page.total < 0 || page.offset !== rows.length
          || (revision !== null && page.revision !== revision) || (total !== null && page.total !== total)
          || !Array.isArray(page.rows) || page.rows.length !== Math.min(500, page.total - rows.length))
          throw new Error('Invalid or incomplete checklist snapshot');
        revision = page.revision; total = page.total;
        for (const row of page.rows) {
          if (!row || typeof row.id !== 'string' || ids.has(row.id)) throw new Error('Duplicate checklist snapshot row');
          ids.add(row.id); rows.push(row);
        }
      } while (rows.length < total!);
      return rows;
    } catch (error) {
      if ((error as { code?: string })?.code !== 'PT409' || attempt === 2) throw error;
    }
  }
  throw new Error('Checklist snapshot keeps changing');
}
