import { useRef, useState } from 'react';
import { Link } from 'expo-router';
import { StyleSheet } from 'react-native';
import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/error-message';
import { useAuth } from '@/features/auth/AuthProvider';
import { mapSupabaseAuthError } from '@/lib/errors/auth-errors';

export default function LoginScreen() {
  const { signIn, state } = useAuth();
  const submittingRef = useRef(false);
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit() { if (submittingRef.current) return; setError(''); if (!/^\S+@\S+\.\S+$/.test(email)) return setError('Введите корректный email'); if (!password) return setError('Введите пароль'); submittingRef.current = true; setBusy(true); try { await signIn(email.trim(), password); } catch (e) { setError(mapSupabaseAuthError(e)); } finally { submittingRef.current = false; setBusy(false); } }
  return <Screen scrollable><ThemedText type="title">TaskTrace</ThemedText><ThemedText style={styles.tagline}>Задачи и история действий в одном месте.</ThemedText><Input label="Email" placeholder="you@example.com" type="email" value={email} onChangeText={setEmail} autoCapitalize="none" onSubmitEditing={submit} blurOnSubmit returnKeyType="done" enterKeyHint="done"/><Input label="Пароль" placeholder="Введите пароль" type="password" secureTextEntry value={password} onChangeText={setPassword} onSubmitEditing={submit} blurOnSubmit returnKeyType="done" enterKeyHint="done"/><ErrorMessage message={error || state.error || undefined} type="auth"/><Button loading={busy} onPress={submit}>Войти</Button><Link href="/(auth)/forgot-password" style={styles.link}>Забыли пароль?</Link><Link href="/(auth)/register" style={styles.link}>Создать аккаунт</Link></Screen>;
}
const styles = StyleSheet.create({ tagline:{color:'#64748B',marginBottom:32},link:{color:'#2563EB',marginTop:18} });
