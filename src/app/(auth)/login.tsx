import { useEffect, useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/error-message';
import { ThemedText } from '@/components/ui/text';
import { useAuth } from '@/features/auth/AuthProvider';
import { AuthForm, AuthLink, AuthNotice, readAuthInputValue } from '@/features/auth/components/auth-form';
import { mapSupabaseAuthError } from '@/lib/errors/auth-errors';
import { useEmailCooldown } from '@/features/auth/use-email-cooldown';

export default function LoginScreen() {
  const { signIn, resendConfirmation, state, clearError } = useAuth();
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<{ email?: string; password?: string }>({});
  const [confirmationEmail, setConfirmationEmail] = useState('');
  const [confirmationSent, setConfirmationSent] = useState(false);
  const [sendingConfirmation, setSendingConfirmation] = useState(false);
  const cooldown = useEmailCooldown('signup', confirmationEmail);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

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
    setConfirmationEmail('');
    setConfirmationSent(false);
    clearError();
    if (next.email || next.password) return;
    submittingRef.current = true;
    setBusy(true);
    try { await signIn(nextEmail.trim(), nextPassword); }
    catch (e) {
      if (!mountedRef.current) return;
      setError(mapSupabaseAuthError(e));
      if ((e as { code?: string } | null)?.code === 'email_not_confirmed') setConfirmationEmail(nextEmail.trim());
    }
    finally { submittingRef.current = false; if (mountedRef.current) setBusy(false); }
  }

  async function resend() {
    if (submittingRef.current || cooldown.disabled || !confirmationEmail) return;
    submittingRef.current = true;
    setSendingConfirmation(true);
    setError('');
    clearError();
    try { await resendConfirmation(confirmationEmail); if (mountedRef.current) setConfirmationSent(true); }
    catch (e) { if (mountedRef.current) setError(mapSupabaseAuthError(e)); }
    finally { submittingRef.current = false; if (mountedRef.current) setSendingConfirmation(false); }
  }

  return <AuthForm title="Вход в аккаунт" description="Продолжите работу над проектами и этапами." footer={<><ThemedText type="small">Ещё нет аккаунта?</ThemedText><AuthLink href="/(auth)/register">Создать аккаунт</AuthLink></>}>
    <Input ref={emailRef} label="Email" placeholder="you@example.com" type="email" defaultValue="" onChangeText={(value) => { setEmail(value); setFields((prev) => ({ ...prev, email: undefined })); setError(''); setConfirmationEmail(''); setConfirmationSent(false); clearError(); }} error={fields.email} disabled={busy || sendingConfirmation} autoCapitalize="none" autoComplete="email" autoCorrect={false} onSubmitEditing={() => passwordRef.current?.focus()} returnKeyType="next" enterKeyHint="next" />
    <Input ref={passwordRef} label="Пароль" placeholder="Введите пароль" type="password" defaultValue="" onChangeText={(value) => { setPassword(value); setFields((prev) => ({ ...prev, password: undefined })); setError(''); clearError(); }} error={fields.password} disabled={busy} autoComplete="current-password" onSubmitEditing={() => void submit()} returnKeyType="go" enterKeyHint="go" />
    <ErrorMessage message={error || state.error || undefined} type="auth" />
    {confirmationEmail ? <>
      {confirmationSent ? <AuthNotice title="Проверьте почту">Если аккаунт с адресом {confirmationEmail} ожидает подтверждения, на него придёт письмо. Если письма нет, проверьте папку «Спам».</AuthNotice> : null}
      <Button fullWidth variant="outline" disabled={busy || cooldown.disabled} loading={sendingConfirmation} accessibilityLiveRegion="none" accessibilityLabel={sendingConfirmation ? 'Отправляем письмо…' : cooldown.accessibilityLabel} onPress={() => void resend()}>{sendingConfirmation ? 'Отправляем письмо…' : cooldown.label}</Button>
    </> : null}
    <Button fullWidth loading={busy} disabled={sendingConfirmation} onPress={() => void submit()}>{busy ? 'Входим…' : 'Войти'}</Button>
    <AuthLink href="/(auth)/forgot-password">Забыли пароль?</AuthLink>
  </AuthForm>;
}
