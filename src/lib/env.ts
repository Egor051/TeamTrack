/**
 * Centralized environment access for the TaskTrace client.
 *
 * Only values prefixed with EXPO_PUBLIC_ are statically inlined into the
 * JavaScript bundle by Expo. No secrets are read here — the public anon key
 * is intentionally not a secret and is consumed only against the Supabase
 * project whose RLS policies enforce authorization server-side.
 */

export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

function requireEnv(key: 'EXPO_PUBLIC_SUPABASE_URL' | 'EXPO_PUBLIC_SUPABASE_ANON_KEY', value: string | undefined): string {
  if (!value || value.length === 0 || value.startsWith('YOUR_') || value.includes('YOUR_PROJECT_REF')) {
    throw new Error(
      `Missing environment variable ${key}. Add it to your \`.env\` file ` +
        `(see .env.example) and restart the dev server.`,
    );
  }
  return value;
}

let cached: SupabaseEnv | null = null;

/**
 * Public, inlined Supabase configuration. Memoized because EXPO_PUBLIC_*
 * values are constants for the lifetime of the bundle.
 */
export function supabaseEnv(): SupabaseEnv {
  if (cached === null) {
    cached = {
      url: requireEnv('EXPO_PUBLIC_SUPABASE_URL', process.env.EXPO_PUBLIC_SUPABASE_URL),
      anonKey: requireEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY', process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY),
    };
  }
  return cached;
}

