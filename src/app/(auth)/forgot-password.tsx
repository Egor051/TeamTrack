import { useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/error-message';
import { useAuth } from '@/features/auth/AuthProvider';
import { AuthForm, AuthLink, AuthNotice, readAuthInputValue } from '@/features/auth/components/auth-form';

export default function ForgotPassword() {
  const { requestPasswordReset, state, clearError } = useAuth();
  const submittingRef = useRef(false);
  const emailRef = useRef<TextInput>(null);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (submittingRef.current || sent) return;
    const nextEmail = readAuthInputValue(emailRef, email);
    setEmail(nextEmail);
    setError('');
    clearError();
    if (!/^\S+@\S+\.\S+$/.test(nextEmail.trim())) { setEmailError('Введите корректный email.'); return; }
    submittingRef.current = true;
    setBusy(true);
    try { await requestPasswordReset(nextEmail.trim()); setSent(true); }
    catch { setError('Не удалось отправить ссылку. Проверьте соединение и попробуйте ещё раз.'); }
    finally { submittingRef.current = false; setBusy(false); }
  }

  return <AuthForm title="Восстановление пароля" description={sent ? 'Откройте письмо, чтобы задать новый пароль.' : 'Введите email, который использовали при регистрации.'} footer={<AuthLink href="/(auth)/login">Вернуться ко входу</AuthLink>}>
    {sent ? <>
      <AuthNotice title="Проверьте почту">Если аккаунт с адресом {email.trim()} существует, на него придёт ссылка для восстановления. Если письма нет, проверьте папку «Спам».</AuthNotice>
      <Button fullWidth variant="outline" onPress={() => { setSent(false); setEmailError(''); setError(''); }}>Указать другой email</Button>
    </> : <>
      <Input ref={emailRef} label="Email" placeholder="you@example.com" type="email" defaultValue="" onChangeText={(value) => { setEmail(value); setEmailError(''); setError(''); clearError(); }} error={emailError} disabled={busy} autoComplete="email" autoCorrect={false} onSubmitEditing={() => void submit()} returnKeyType="send" enterKeyHint="send" />
      <ErrorMessage message={error || state.error || undefined} type="auth" />
      <Button fullWidth loading={busy} onPress={() => void submit()}>{busy ? 'Отправляем ссылку…' : 'Отправить ссылку'}</Button>
    </>}
  </AuthForm>;
}
