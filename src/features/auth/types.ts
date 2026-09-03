import type { Session, User } from '@supabase/supabase-js';
import type { Profile } from '@/lib/supabase/client';

/**
 * AuthState represents the current authentication status.
 * It's the single source of truth for auth in the app.
 */
export type AuthState = {
  /** True while we're checking for an existing session (on app start) */
  isLoading: boolean;
  /** The current Supabase session, if any */
  session: Session | null;
  /** The current user profile, if any */
  profile: Profile | null;
  /** The raw Supabase Auth user, if any */
  user: User | null;
  /** Human-readable error message, if any */
  error: string | null;
};