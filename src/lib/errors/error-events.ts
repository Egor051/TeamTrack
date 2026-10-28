import { annotateError, type ErrorContext } from './operation-error';

type Listener = (error: unknown, context: ErrorContext) => void;
const listeners = new Set<Listener>();

/** Observers cannot change the outcome of a user operation or report themselves. */
export function reportClientError(error: unknown, context: ErrorContext = {}): void {
  annotateError(error, context);
  for (const listener of listeners) {
    try { listener(error, context); } catch { /* Diagnostics is best effort. */ }
  }
}
export function subscribeClientErrors(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
