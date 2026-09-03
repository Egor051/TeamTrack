import { Redirect, Stack } from 'expo-router';
import { useAuth } from '@/features/auth/AuthProvider';
import { LoadingScreen } from '@/components/ui/loading-screen';

export default function AppGroupLayout() {
  const { state } = useAuth();
  if (state.isLoading) return <LoadingScreen />;
  if (!state.session) return <Redirect href="/(auth)/login" />;
  return <Stack key={state.user?.id ?? 'signed-out'} screenOptions={{ headerShown: false }} />;
}
