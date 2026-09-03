import { useEffect, useState } from 'react';
import { Link, router } from 'expo-router';
import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ErrorMessage } from '@/components/ui/error-message';
import { useAuth } from '@/features/auth/AuthProvider';

export default function ResetPasswordScreen() {
  const { updatePassword, session } = useAuthStateCompat();
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState(''); const [error, setError] = useState(''); const [done, setDone] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => router.replace('/(app)/profile'), 500);
    return () => clearTimeout(timer);
  }, [done]);
  async function submit() { setError(''); if (!session) return setError('Сессия восстановления не найдена.'); if (password.length < 8) return setError('Пароль должен иметь минимум 8 символов, нужны строчные и прописные буквы и цифры'); if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/.test(password)) return setError('Пароль должен содержать строчные и прописные буквы и цифры'); if (password !== confirm) return setError('Пароли не совпадают'); setBusy(true); try { await updatePassword(password); setDone(true); } catch { setError('Не удалось обновить пароль. Запросите новую ссылку.'); } finally { setBusy(false); } }
  return <Screen><ThemedText type="title">Новый пароль</ThemedText>{done ? <ThemedText>Пароль обновлён. Выполняется вход...</ThemedText> : <><Input label="Новый пароль" placeholder="Минимум 8 символов, строчные и прописные буквы и цифры" type="password" secureTextEntry value={password} onChangeText={setPassword}/><Input label="Подтверждение" placeholder="Повторите пароль" type="password" secureTextEntry value={confirm} onChangeText={setConfirm}/><ErrorMessage message={error || (!session ? 'Ссылка недействительна или истекла. Запросите новую.' : undefined)} type="auth"/><Button loading={busy} onPress={submit}>Обновить пароль</Button></>}<Link href="/(auth)/login" style={{color:'#2563EB',marginTop:18}}>Вернуться ко входу</Link></Screen>;
}
function useAuthStateCompat() { const auth = useAuth(); return { updatePassword: auth.updatePassword, session: auth.state.session }; }
