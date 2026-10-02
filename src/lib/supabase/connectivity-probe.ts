import type { Session, AuthError } from '@supabase/supabase-js';
import { requestDeadline } from '@/lib/connectivity/deadline';
import { revalidateAuthTransport } from '@/lib/connectivity/fetch';
import { isTransportFailure } from '@/lib/connectivity/errors';

type SessionReader = { getSession: () => Promise<{ data: { session: Session | null }; error: AuthError | null }> };
async function probeFetch(url: string, headers: Record<string, string>): Promise<Response> {
  const deadline = requestDeadline(5000);
  try { return await fetch(url, { headers, signal: deadline.signal }); }
  catch (error) {
    if (deadline.expired() && (error as Error)?.name === 'AbortError') throw new Error('Connectivity probe timed out');
    throw error;
  } finally { deadline.dispose(); }
}
async function requireReachable(response: Response): Promise<void> {
  if (response.ok) return;
  let error = { status: response.status, message: 'Connectivity probe failed', code: '' };
  try { const body = await response.json(); error = { ...error, message: body?.message ?? error.message, code: body?.code ?? '' }; }
  catch { /* HTML/empty gateway response */ }
  if (isTransportFailure(error)) throw error;
  // A 4xx/business response proves transport has returned. The subsequent
  // normal loaders must surface these authoritative errors, never cache them.
}
export async function probeSupabase(url: string, key: string, auth: SessionReader): Promise<void> {
  // Schema introspection can require a secret key. Public Auth health works
  // with publishable keys; it only opens the SDK auth recovery path.
  const health = await probeFetch(`${url}/auth/v1/health`, { apikey: key });
  if (!health.ok) throw { status: health.status, message: 'Auth connectivity probe failed' };
  const { data, error } = await revalidateAuthTransport(() => auth.getSession());
  if (error && isTransportFailure(error)) throw error;
  // SDK handles invalid/expired session removal. With no session there is no
  // offline account namespace; restored Auth availability permits login.
  if (!data.session) return;
  await requireReachable(await probeFetch(`${url}/rest/v1/projects?select=id&limit=0`, {
    apikey: key, Authorization: `Bearer ${data.session.access_token}`,
  }));
}
