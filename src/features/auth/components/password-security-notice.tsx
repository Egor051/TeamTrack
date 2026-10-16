import { StyleSheet, View } from 'react-native';
import { Link } from 'expo-router';
import { useAuth } from '../AuthProvider';
import { Button } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/error-message';

/** A successful sign-in remains successful; this is an account-scoped notice. */
export function PasswordSecurityNotice() {
  const { passwordWarning } = useAuth();
  if (!passwordWarning) return null;
  return <View style={styles.notice}>
    <ErrorMessage message={passwordWarning} />
    <Link href="/reset-password" asChild><Button size="sm" variant="outline" accessibilityRole="link">Сменить пароль</Button></Link>
  </View>;
}

const styles = StyleSheet.create({ notice: { padding: 12, gap: 8, alignItems: 'flex-start' } });
