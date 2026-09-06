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
import { ThemeProvider } from '@/components/ui/theme-provider';

export default function RootLayout() {
  return (
    <SafeAreaProvider><ThemeProvider><AuthProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'fade',
        }}
      />
      <StatusBar style="auto" />
    </AuthProvider></ThemeProvider></SafeAreaProvider>
  );
}
