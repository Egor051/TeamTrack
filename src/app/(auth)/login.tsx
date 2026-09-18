import { useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/error-message';
import { ThemedText } from '@/components/ui/text';
import { useAuth } from '@/features/auth/AuthProvider';
import { AuthForm, AuthLink, readAuthInputValue } from '@/features/auth/components/auth-form';
import { mapSupabaseAuthError } from '@/lib/errors/auth-errors';

export default function LoginScreen() {
  const { signIn, state, clearError } = useAuth();
  const submittingRef = useRef(false);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<{ email?: string; password?: string }>({});

  async function submit() {
    if (submittingRef.current) return;
    const nextEmail = readAuthInputValue(emailRef, email);
    const nextPassword = readAuthInputValue(passwordRef, password);
    setEmail(nextEmail);
    setPassword(nextPassword);
    const next = {
      email: /^\S+@\S+\.\S+$/.test(nextEmail.trim()) ? undefined : 'Введите корректный email.',
      password: nextPassword ? undefined : 'Введите пароль.',
    };
    setFields(next);
    setError('');
    clearError();
    if (next.email || next.password) return;
    submittingRef.current = true;
    setBusy(true);
    try { await signIn(nextEmail.trim(), nextPassword); }
    catch (e) { setError(mapSupabaseAuthError(e)); }
    finally { submittingRef.current = false; setBusy(false); }
  }

  return <AuthForm title="Вход в аккаунт" description="Продолжите работу над проектами и этапами." footer={<><ThemedText type="small">Ещё нет аккаунта?</ThemedText><AuthLink href="/(auth)/register">Создать аккаунт</AuthLink></>}>
    <Input ref={emailRef} label="Email" placeholder="you@example.com" type="email" defaultValue="" onChangeText={(value) => { setEmail(value); setFields((prev) => ({ ...prev, email: undefined })); setError(''); clearError(); }} error={fields.email} disabled={busy} autoCapitalize="none" autoComplete="email" autoCorrect={false} onSubmitEditing={() => passwordRef.current?.focus()} returnKeyType="next" enterKeyHint="next" />
    <Input ref={passwordRef} label="Пароль" placeholder="Введите пароль" type="password" defaultValue="" onChangeText={(value) => { setPassword(value); setFields((prev) => ({ ...prev, password: undefined })); setError(''); clearError(); }} error={fields.password} disabled={busy} autoComplete="current-password" onSubmitEditing={() => void submit()} returnKeyType="go" enterKeyHint="go" />
    <ErrorMessage message={error || state.error || undefined} type="auth" />
    <Button fullWidth loading={busy} onPress={() => void submit()}>{busy ? 'Входим…' : 'Войти'}</Button>
    <AuthLink href="/(auth)/forgot-password">Забыли пароль?</AuthLink>
  </AuthForm>;
}
