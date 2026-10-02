import { requestDeadline } from '@/lib/connectivity/deadline';
export const UI_READ_TIMEOUT_MS = 5000;

// Limit individual UI queries; bootstrap and sync retain their own budgets.
// Promise-only adapters can also use this helper without query modifiers.
export async function uiRead<T>(query: PromiseLike<T> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<T>;
  retry?: (enabled: boolean) => PromiseLike<T>;
}): Promise<T> {
  query.retry?.(false);
  const deadline = requestDeadline(UI_READ_TIMEOUT_MS);
  try {
    const result = await (query.abortSignal?.(deadline.signal) ?? query);
    const response = result as { error?: { status?: number; message?: string; code?: string }; status?: number } | null;
    // PostgREST stores HTTP status outside its error object. Retain denials.
    if (response?.error && typeof response.status === 'number') response.error.status = response.status;
    // RN discards abort reasons. Only our own deadline's aborted transport
    // result becomes a timeout; never replace a server denial/business reply.
    if (deadline.expired() && response?.status === 0 && response.error
      && !response.error.code && /abort/i.test(response.error.message ?? '')) response.error.message = 'Request timed out';
    return result;
  } catch (error) {
    if (deadline.expired() && (error as Error)?.name === 'AbortError') throw new Error('Request timed out');
    throw error;
  } finally { deadline.dispose(); }
}
