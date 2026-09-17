import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import type { TextInput } from 'react-native';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/error-message';
import { ThemedText } from '@/components/ui/text';
import { useAuth } from '@/features/auth/AuthProvider';
import { AuthForm, AuthLink, AuthNotice } from '@/features/auth/components/auth-form';
import { mapSupabaseAuthError } from '@/lib/errors/auth-errors';

type FieldErrors = { name?: string; email?: string; password?: string; confirm?: string };

export default function RegisterScreen() {
  const { signUp, state, clearError } = useAuth();
  const submittingRef = useRef(false);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [fields, setFields] = useState<FieldErrors>({});

  useEffect(() => { if (state.session) router.replace('/projects'); }, [state.session]);

  function clearField(field: keyof FieldErrors) {
    setFields((prev) => ({ ...prev, [field]: undefined }));
    setError('');
  }

  async function submit() {
    if (submittingRef.current || done) return;
    const next: FieldErrors = {
      name: name.trim() ? undefined : 'Введите имя.',
      email: /^\S+@\S+\.\S+$/.test(email.trim()) ? undefined : 'Введите корректный email.',
      password: password.length < 8 ? 'Нужно не менее 8 символов.' : !/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password) ? 'Добавьте строчные и прописные латинские буквы и цифры.' : undefined,
      confirm: password !== confirm ? 'Пароли не совпадают.' : !confirm ? 'Повторите пароль.' : undefined,
    };
    setFields(next);
    setError('');
    clearError();
    if (Object.values(next).some(Boolean)) return;
    submittingRef.current = true;
    setBusy(true);
    try { await signUp(email.trim(), password, name.trim()); setDone(true); }
    catch (e) { setError(mapSupabaseAuthError(e)); }
    finally { submittingRef.current = false; setBusy(false); }
  }

  return <AuthForm title={done ? 'Подтвердите email' : 'Создать аккаунт'} description={done ? 'Остался один шаг перед началом работы.' : 'Создавайте проекты и работайте над этапами вместе.'} footer={<><ThemedText type="small">Уже есть аккаунт?</ThemedText><AuthLink href="/(auth)/login">Войти</AuthLink></>}>
    {done ? <AuthNotice title="Проверьте почту">Откройте письмо на {email.trim()} и перейдите по ссылке для подтверждения аккаунта. Если письма нет, проверьте папку «Спам».</AuthNotice> : <>
      <Input label="Имя" placeholder="Как к вам обращаться" value={name} onChangeText={(value) => { setName(value); clearField('name'); clearError(); }} error={fields.name} disabled={busy} autoCapitalize="words" autoComplete="name" onSubmitEditing={() => emailRef.current?.focus()} returnKeyType="next" enterKeyHint="next" />
      <Input ref={emailRef} label="Email" placeholder="you@example.com" type="email" value={email} onChangeText={(value) => { setEmail(value); clearField('email'); clearError(); }} error={fields.email} disabled={busy} autoComplete="email" autoCorrect={false} onSubmitEditing={() => passwordRef.current?.focus()} returnKeyType="next" enterKeyHint="next" />
      <Input ref={passwordRef} label="Пароль" placeholder="Придумайте пароль" hint="Не менее 8 символов: строчные и прописные латинские буквы и цифры." type="password" value={password} onChangeText={(value) => { setPassword(value); clearField('password'); clearError(); }} error={fields.password} disabled={busy} autoComplete="new-password" onSubmitEditing={() => confirmRef.current?.focus()} returnKeyType="next" enterKeyHint="next" />
      <Input ref={confirmRef} label="Повторите пароль" placeholder="Введите пароль ещё раз" type="password" value={confirm} onChangeText={(value) => { setConfirm(value); clearField('confirm'); clearError(); }} error={fields.confirm} disabled={busy} autoComplete="new-password" onSubmitEditing={() => void submit()} returnKeyType="go" enterKeyHint="go" />
      <ErrorMessage message={error || state.error || undefined} type="auth" />
      <Button fullWidth loading={busy} onPress={() => void submit()}>{busy ? 'Создаём аккаунт…' : 'Создать аккаунт'}</Button>
    </>}
  </AuthForm>;
}
