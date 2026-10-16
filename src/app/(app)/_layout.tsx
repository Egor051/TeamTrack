import { Redirect, Stack } from 'expo-router';
import { useAuth } from '@/features/auth/AuthProvider';
import { LoadingScreen } from '@/components/ui/loading-screen';
import { useTheme } from '@/components/ui/theme-provider';
import { PermissionProvider } from '@/features/auth/PermissionProvider';
import { View } from 'react-native';
import { AppNavigation } from '@/features/notifications/app-navigation';
import { PasswordSecurityNotice } from '@/features/auth/components/password-security-notice';

export default function AppGroupLayout() {
  const { state } = useAuth();
  const { colors } = useTheme();
  if (state.isLoading) return <LoadingScreen />;
  if (!state.session) return <Redirect href="/(auth)/login" />;
  return <PermissionProvider userId={state.user?.id ?? null}><View style={{ flex: 1 }}><AppNavigation key={state.user?.id ?? 'signed-out'} /><PasswordSecurityNotice /><Stack key={state.user?.id ?? 'signed-out'} screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} /></View></PermissionProvider>;
}
