import type { Session, AuthError } from '@supabase/supabase-js';
import * as client from './client';
import { usesLocalReads, subscribeConnectivity } from '@/lib/connectivity/state';

// A stored session identifies this device's cache namespace; it is never
// proof of current server authorization. Online validation remains in the SDK.
export async function getReadSession(): Promise<{ data: { session: Session | null }; error: AuthError | null }> {
  if (usesLocalReads() && 'readPersistedSession' in client) return { data: { session: await client.readPersistedSession() }, error: null };
  let unsubscribe: () => void = () => undefined;
  // A refresh can discover a transport failure after restoration has begun.
  // Release UI callers then, while the SDK completes its own retry lifecycle.
  const localOnFailure = new Promise<{ data: { session: Session | null }; error: null }>((resolve) => {
    unsubscribe = subscribeConnectivity((next) => {
      if (next !== 'online' && 'readPersistedSession' in client) {
        void client.readPersistedSession().then((session) => resolve({ data: { session }, error: null }));
      }
    });
  });
  try { return await Promise.race([client.supabase.auth.getSession(), localOnFailure]); }
  finally { unsubscribe(); }
}
