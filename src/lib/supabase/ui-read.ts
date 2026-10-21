import { boundedOperation } from '@/lib/connectivity/deadline';
export const UI_READ_TIMEOUT_MS = 5000;

// Limit individual UI queries; bootstrap and sync retain their own budgets.
// Promise-only adapters can also use this helper without query modifiers.
export async function uiRead<T>(query: PromiseLike<T> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<T>;
  retry?: (enabled: boolean) => PromiseLike<T>;
}, parent?: AbortSignal): Promise<T> {
  query.retry?.(false);
  try {
    const result = await boundedOperation((signal) => query.abortSignal?.(signal) ?? query, UI_READ_TIMEOUT_MS, parent);
    const response = result as { error?: { status?: number; message?: string; code?: string }; status?: number } | null;
    // PostgREST stores HTTP status outside its error object. Retain denials.
    if (response?.error && typeof response.status === 'number') response.error.status = response.status;
    return result;
  } catch (error) {
    if ((error as Error)?.name === 'TimeoutError') throw Object.assign(new Error('Request timed out'), { name: 'TimeoutError' });
    throw error;
  }
}
