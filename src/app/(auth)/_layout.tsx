/**
 * (auth) group layout — guards unauthenticated routes.
 *
 * Redirects to /projects if the user is already authenticated.
 * The LoadingScreen is shown while the session is being restored.
 */
import { Redirect, Stack, usePathname } from "expo-router";
import { useAuth } from "@/features/auth/AuthProvider";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { useTheme } from "@/components/ui/theme-provider";

export default function AuthGroupLayout() {
  const { state } = useAuth();
  const { colors } = useTheme();
  const pathname = usePathname();

  if (state.isLoading) {
    return <LoadingScreen />;
  }

  // A recovery session is intentionally active while the reset form is open.
  // Keep that route mounted so the user can submit the new password.
  if (state.session && !pathname.endsWith('/reset-password')) {
    return <Redirect href="/projects" />;
  }

  // A cached shell can recreate this group before a deep-link redirect settles.
  // Its fallback must be login, rather than the first alphabetically named file.
  return <Stack initialRouteName="login" screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
}
