import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Screen } from '@/components/ui/screen';
import { PageHeader } from '@/components/ui/page-header';
import { ThemedText } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorMessage } from '@/components/ui/error-message';
import { layout, spacing } from '@/components/ui/theme';
import { createProject } from '@/features/projects/projects';
import { userMessage } from '@/lib/errors/user-message';

export default function NewProjectScreen() {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitRef = useRef(false);

  async function submit() {
    if (submitRef.current) return;
    if (!name.trim()) return setError('Введите название проекта.');
    submitRef.current = true;
    setBusy(true);
    setError('');
    try {
      const id = await createProject(name.trim(), description.trim());
      router.replace(`/projects/${id}` as never);
    } catch (e) {
      setError(userMessage(e, 'Не удалось создать проект. Попробуйте ещё раз.'));
    } finally {
      submitRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Screen scrollable centerContent={false} maxWidth={layout.readingMaxWidth} contentStyle={styles.content}>
      <PageHeader
        title="Новый проект"
        subtitle="Объедините задачи и участников вокруг общей цели."
        onBack={() => router.replace('/projects')}
        backLabel="К проектам"
        breadcrumbs={[{ label: 'Проекты', href: '/projects' }, { label: 'Новый проект' }]}
      />
      <Card style={styles.form}>
        <ThemedText type="h2">О проекте</ThemedText>
        <Input
          label="Название проекта"
          placeholder="Например, запуск нового сайта"
          value={name}
          onChangeText={setName}
          autoCapitalize="sentences"
          disabled={busy}
          autoFocus
        />
        <Textarea
          label="Описание · необязательно"
          placeholder="Что нужно сделать и какой результат вы ожидаете"
          value={description}
          onChangeText={setDescription}
          autoCapitalize="sentences"
          disabled={busy}
        />
        <ThemedText type="small">Задачи и участников можно добавить после создания проекта.</ThemedText>
        <ErrorMessage message={error} type="validation" />
        <View style={styles.actions}>
          <Button loading={busy} disabled={busy || !name.trim()} onPress={() => void submit()}>Создать проект</Button>
          <Button variant="ghost" disabled={busy} onPress={() => router.replace('/projects')}>Отмена</Button>
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.xl },
  form: { gap: spacing.lg },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
});
