import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import type { TextInput } from 'react-native';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/error-message';
import { useAuth } from '@/features/auth/AuthProvider';
import { AuthForm, AuthLink, AuthNotice } from '@/features/auth/components/auth-form';

export default function ResetPasswordScreen() {
  const { updatePassword, state, clearError } = useAuth();
  const submittingRef = useRef(false);
  const confirmRef = useRef<TextInput>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fields, setFields] = useState<{ password?: string; confirm?: string }>({});
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => router.replace('/projects'), 500);
    return () => clearTimeout(timer);
  }, [done]);

  async function submit() {
    if (submittingRef.current || done || !state.session) return;
    const next = {
      password: password.length < 8 ? 'Нужно не менее 8 символов.' : !/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password) ? 'Добавьте строчные и прописные латинские буквы и цифры.' : undefined,
      confirm: password !== confirm ? 'Пароли не совпадают.' : !confirm ? 'Повторите пароль.' : undefined,
    };
    setFields(next);
    setError('');
    clearError();
    if (next.password || next.confirm) return;
    submittingRef.current = true;
    setBusy(true);
    try { await updatePassword(password); setDone(true); }
    catch { setError('Не удалось обновить пароль. Попробуйте ещё раз или запросите новую ссылку.'); }
    finally { submittingRef.current = false; setBusy(false); }
  }

  return <AuthForm title="Новый пароль" description="Задайте пароль для входа в ваш аккаунт." footer={<AuthLink href="/(auth)/login">Вернуться ко входу</AuthLink>}>
    {done ? <AuthNotice title="Пароль обновлён">Открываем ваши проекты…</AuthNotice> : !state.session ? <>
      <ErrorMessage message="Ссылка недействительна или истекла. Получите новую ссылку для восстановления пароля." type="auth" />
      <AuthLink href="/(auth)/forgot-password" primary>Запросить новую ссылку</AuthLink>
    </> : <>
      <Input label="Новый пароль" placeholder="Придумайте пароль" hint="Не менее 8 символов: строчные и прописные латинские буквы и цифры." type="password" value={password} onChangeText={(value) => { setPassword(value); setFields((prev) => ({ ...prev, password: undefined })); setError(''); clearError(); }} error={fields.password} disabled={busy} autoComplete="new-password" onSubmitEditing={() => confirmRef.current?.focus()} returnKeyType="next" enterKeyHint="next" />
      <Input ref={confirmRef} label="Повторите пароль" placeholder="Введите пароль ещё раз" type="password" value={confirm} onChangeText={(value) => { setConfirm(value); setFields((prev) => ({ ...prev, confirm: undefined })); setError(''); clearError(); }} error={fields.confirm} disabled={busy} autoComplete="new-password" onSubmitEditing={() => void submit()} returnKeyType="go" enterKeyHint="go" />
      <ErrorMessage message={error || state.error || undefined} type="auth" />
      <Button fullWidth loading={busy} onPress={() => void submit()}>{busy ? 'Сохраняем пароль…' : 'Сохранить пароль'}</Button>
      {error ? <AuthLink href="/(auth)/forgot-password">Запросить новую ссылку</AuthLink> : null}
    </>}
  </AuthForm>;
}
