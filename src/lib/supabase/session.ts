import type { Session, AuthError } from '@supabase/supabase-js';
import * as client from './client';
import { usesLocalReads, subscribeConnectivity } from '@/lib/connectivity/state';
import { boundedOperation } from '@/lib/connectivity/deadline';

export const READ_SESSION_TIMEOUT_MS = 40_000;
const storedSession = () => boundedOperation(() => client.readPersistedSession(), 5000);

// A stored session identifies this device's cache namespace; it is never
// proof of current server authorization. Online validation remains in the SDK.
export async function getReadSession(): Promise<{ data: { session: Session | null }; error: AuthError | null }> {
  if (usesLocalReads() && 'readPersistedSession' in client) return { data: { session: await storedSession() }, error: null };
  let unsubscribe: () => void = () => undefined;
  // A refresh can discover a transport failure after restoration has begun.
  // Release UI callers then, while the SDK completes its own retry lifecycle.
  const localOnFailure = new Promise<{ data: { session: Session | null }; error: null }>((resolve, reject) => {
    unsubscribe = subscribeConnectivity((next) => {
      if (next !== 'online' && 'readPersistedSession' in client) {
        void storedSession().then((session) => resolve({ data: { session }, error: null }), reject);
      }
    });
  });
  try { return await boundedOperation(() => Promise.race([client.supabase.auth.getSession(), localOnFailure]), READ_SESSION_TIMEOUT_MS); }
  catch (error) {
    // A blocked SDK/storage operation is not evidence of an Internet outage.
    // Reject without signing out or modifying the saved account/outbox.
    if ((error as Error)?.name === 'TimeoutError')
      throw Object.assign(new Error('Не удалось проверить сеанс. Повторите обновление.'), { name: 'AuthSessionUnavailableError' });
    throw error;
  }
  finally { unsubscribe(); }
}
