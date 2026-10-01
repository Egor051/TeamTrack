/**
 * TaskTrace — root layout.
 *
 * Wraps the entire app with:
 * - Expo Router Stack
 * - AuthProvider (auth state + session listener)
 *
 * Route protection is handled by the (auth) and (app) group layouts.
 */
import { Stack, router, usePathname } from 'expo-router';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuthState } from '@/features/auth/AuthProvider';
import { SyncProvider } from '@/lib/local-cache/SyncProvider';
import { ConflictGate } from '@/lib/local-cache/ConflictGate';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from '@/components/ui/theme-provider';
import { PwaUpdateBanner } from '@/components/pwa-update-banner';

/**
 * RootStack lives inside ThemeProvider so the navigation container always
 * follows the resolved theme: no white flash on transitions or empty areas.
 */
function RootStack() {
  const { resolved, colors } = useTheme();
  const { isLoading, session } = useAuthState();
  const pathname = usePathname();

  useEffect(() => {
    if (isLoading || !session || typeof window === 'undefined' || pathname !== '/projects') return;
    const initialPath = (window as Window & { __TASKTRACE_INITIAL_PATH__?: string }).__TASKTRACE_INITIAL_PATH__;
    if (!initialPath || !/^\/projects\/[^/.]+(?:\/[^/.]+)*\/?$/.test(initialPath)) return;
    delete (window as Window & { __TASKTRACE_INITIAL_PATH__?: string }).__TASKTRACE_INITIAL_PATH__;
    router.replace(initialPath as never);
  }, [isLoading, pathname, session]);
  return (
    <>
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'fade',
          contentStyle: { backgroundColor: colors.background },
        }}
      />
      <StatusBar style={resolved === 'dark' ? 'light' : 'dark'} />
      <PwaUpdateBanner />
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider><ThemeProvider><AuthProvider><SyncProvider><ConflictGate>
      <RootStack />
    </ConflictGate></SyncProvider></AuthProvider></ThemeProvider></SafeAreaProvider>
  );
}
