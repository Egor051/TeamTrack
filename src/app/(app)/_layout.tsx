import { Redirect, Stack } from 'expo-router';
import { useAuth } from '@/features/auth/AuthProvider';
import { LoadingScreen } from '@/components/ui/loading-screen';
import { useTheme } from '@/components/ui/theme-provider';

export default function AppGroupLayout() {
  const { state } = useAuth();
  const { colors } = useTheme();
  if (state.isLoading) return <LoadingScreen />;
  if (!state.session) return <Redirect href="/(auth)/login" />;
  return <Stack key={state.user?.id ?? 'signed-out'} screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }} />;
}
