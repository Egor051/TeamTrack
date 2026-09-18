import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import type { TextInput } from 'react-native';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/error-message';
import { ThemedText } from '@/components/ui/text';
import { useAuth } from '@/features/auth/AuthProvider';
import { AuthForm, AuthLink, AuthNotice, readAuthInputValue } from '@/features/auth/components/auth-form';
import { mapSupabaseAuthError } from '@/lib/errors/auth-errors';

type FieldErrors = { name?: string; email?: string; password?: string; confirm?: string };

export default function RegisterScreen() {
  const { signUp, state, clearError } = useAuth();
  const submittingRef = useRef(false);
  const nameRef = useRef<TextInput>(null);
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
    const nextName = readAuthInputValue(nameRef, name);
    const nextEmail = readAuthInputValue(emailRef, email);
    const nextPassword = readAuthInputValue(passwordRef, password);
    const nextConfirm = readAuthInputValue(confirmRef, confirm);
    setName(nextName);
    setEmail(nextEmail);
    setPassword(nextPassword);
    setConfirm(nextConfirm);
    const next: FieldErrors = {
      name: nextName.trim() ? undefined : 'Введите имя.',
      email: /^\S+@\S+\.\S+$/.test(nextEmail.trim()) ? undefined : 'Введите корректный email.',
      password: nextPassword.length < 8 ? 'Нужно не менее 8 символов.' : !/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(nextPassword) ? 'Добавьте строчные и прописные латинские буквы и цифры.' : undefined,
      confirm: nextPassword !== nextConfirm ? 'Пароли не совпадают.' : !nextConfirm ? 'Повторите пароль.' : undefined,
    };
    setFields(next);
    setError('');
    clearError();
    if (Object.values(next).some(Boolean)) return;
    submittingRef.current = true;
    setBusy(true);
    try { await signUp(nextEmail.trim(), nextPassword, nextName.trim()); setDone(true); }
    catch (e) { setError(mapSupabaseAuthError(e)); }
    finally { submittingRef.current = false; setBusy(false); }
  }

  return <AuthForm title={done ? 'Подтвердите email' : 'Создать аккаунт'} description={done ? 'Остался один шаг перед началом работы.' : 'Создавайте проекты и работайте над этапами вместе.'} footer={<><ThemedText type="small">Уже есть аккаунт?</ThemedText><AuthLink href="/(auth)/login">Войти</AuthLink></>}>
    {done ? <AuthNotice title="Проверьте почту">Откройте письмо на {email.trim()} и перейдите по ссылке для подтверждения аккаунта. Если письма нет, проверьте папку «Спам».</AuthNotice> : <>
      <Input ref={nameRef} label="Имя" placeholder="Как к вам обращаться" type="text" defaultValue="" onChangeText={(value) => { setName(value); clearField('name'); clearError(); }} error={fields.name} disabled={busy} autoCapitalize="words" autoComplete="name" onSubmitEditing={() => emailRef.current?.focus()} returnKeyType="next" enterKeyHint="next" />
      <Input ref={emailRef} label="Email" placeholder="you@example.com" type="email" defaultValue="" onChangeText={(value) => { setEmail(value); clearField('email'); clearError(); }} error={fields.email} disabled={busy} autoComplete="email" autoCorrect={false} onSubmitEditing={() => passwordRef.current?.focus()} returnKeyType="next" enterKeyHint="next" />
      <Input ref={passwordRef} label="Пароль" placeholder="Придумайте пароль" hint="Не менее 8 символов: строчные и прописные латинские буквы и цифры." type="password" defaultValue="" onChangeText={(value) => { setPassword(value); clearField('password'); clearError(); }} error={fields.password} disabled={busy} autoComplete="new-password" onSubmitEditing={() => confirmRef.current?.focus()} returnKeyType="next" enterKeyHint="next" />
      <Input ref={confirmRef} label="Повторите пароль" placeholder="Введите пароль ещё раз" type="password" defaultValue="" onChangeText={(value) => { setConfirm(value); clearField('confirm'); clearError(); }} error={fields.confirm} disabled={busy} autoComplete="new-password" onSubmitEditing={() => void submit()} returnKeyType="go" enterKeyHint="go" />
      <ErrorMessage message={error || state.error || undefined} type="auth" />
      <Button fullWidth loading={busy} onPress={() => void submit()}>{busy ? 'Создаём аккаунт…' : 'Создать аккаунт'}</Button>
    </>}
  </AuthForm>;
}
