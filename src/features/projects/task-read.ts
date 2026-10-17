import { SupersededReadError } from '@/lib/local-cache/cache';

// Keep diagnostics out of product messages and never log row contents, tokens
// or raw server details. A fenced read is expected lifecycle control flow.
export async function taskReadStep<T>(step: string, read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) {
    if (!(error instanceof SupersededReadError)) {
      const value = error as { code?: string; name?: string; status?: number } | null;
      console.warn('[TaskTrace] task read failed', { step, code: value?.code, name: value?.name, status: value?.status });
    }
    throw error;
  }
}
