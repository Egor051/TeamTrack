/**
 * TaskTrace — root layout.
 *
 * Wraps the entire app with:
 * - Expo Router Stack
 * - AuthProvider (auth state + session listener)
 *
 * Route protection is handled by the (auth) and (app) group layouts.
 */
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from '@/components/ui/theme-provider';
import { Platform } from 'react-native';
import { Analytics } from '@vercel/analytics/react';

/**
 * RootStack lives inside ThemeProvider so the navigation container always
 * follows the resolved theme: no white flash on transitions or empty areas.
 */
function RootStack() {
  const { resolved, colors } = useTheme();
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
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider><ThemeProvider><AuthProvider>
      <RootStack />
      {Platform.OS === 'web' && <Analytics />}
    </AuthProvider></ThemeProvider></SafeAreaProvider>
  );
}
