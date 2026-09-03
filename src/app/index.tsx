/**
 * TaskTrace — root index.
 *
 * This is the entry point for the app. It redirects to the appropriate
 * group based on the current auth state:
 *   - while loading  → LoadingScreen
 *   - signed in      → /(app)/profile
 *   - signed out     → /(auth)/login
 *
 * The group layouts (auth)/_layout.tsx and (app)/_layout.tsx also
 * enforce the same constraint, so even if this redirect is bypassed,
 * the user can never end up in the wrong group.
 */
import { Redirect } from 'expo-router';
import { useAuthState } from '@/features/auth/AuthProvider';
import { LoadingScreen } from '@/components/ui/loading-screen';

export default function RootIndex() {
  const { isLoading, session } = useAuthState();

  if (isLoading) {
    return <LoadingScreen />;
  }

  return <Redirect href={session ? ('/projects' as never) : '/(auth)/login'} />;
}
