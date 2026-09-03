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

export default function RootLayout() {
  return (
    <AuthProvider>
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'fade',
        }}
      />
      <StatusBar style="auto" />
    </AuthProvider>
  );
}
