import { useEffect, useRef, useState } from 'react';
import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { ErrorMessage } from '@/components/ui/error-message';
import { router, useLocalSearchParams } from 'expo-router';
import { createTask, createTaskFromTemplate, listTaskTemplates, type TaskTemplate } from '@/features/projects/projects';

export default function NewTask() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [mode, setMode] = useState<'blank' | 'template'>('blank');
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const submitRef = useRef(false);

  useEffect(() => {
    if (mode !== 'template') return;
    void listTaskTemplates().then((rows) => {
      setTemplates(rows);
      if (!templateId && rows[0]) {
        setTemplateId(rows[0].id);
        setTitle(rows[0].name);
        setDescription(rows[0].description || '');
      }
    }).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить шаблоны.')).finally(() => setLoadingTemplates(false));
  }, [mode, templateId]);

  function chooseTemplate(nextId: string) {
    setTemplateId(nextId);
    const selected = templates.find((template) => template.id === nextId);
    setTitle(selected?.name || '');
    setDescription(selected?.description || '');
  }

  async function submit() {
    if (submitRef.current) return;
    if (!title.trim()) return setError('Введите название задачи');
    if (mode === 'template' && !templateId) return setError('Выберите шаблон');
    submitRef.current = true;
    setBusy(true);
    setError('');
    try {
      const taskId = mode === 'template' ? await createTaskFromTemplate(id!, templateId, title.trim(), description.trim()) : await createTask(id!, title.trim(), description.trim());
      router.replace(`/projects/${id}/tasks/${taskId}` as never);
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось создать задачу'); }
    finally { submitRef.current = false; setBusy(false); }
  }

  return <Screen scrollable>
    <ThemedText type="title">Новая задача</ThemedText>
    <SegmentedControl value={mode} onChange={setMode} accessibilityLabel="Способ создания задачи" options={[{ value: 'blank', label: 'С нуля' }, { value: 'template', label: 'Из шаблона' }]} />
    {mode === 'template' ? <Card>
      <ThemedText type="h3">Глобальный шаблон</ThemedText>
      {loadingTemplates ? <LoadingState label="Загружаем шаблоны..." /> : !templates.length ? <EmptyState title="Шаблонов пока нет" description="Администратор проекта может создать глобальный шаблон." /> : <>
        <SegmentedControl value={templateId} onChange={chooseTemplate} accessibilityLabel="Выбор шаблона" options={templates.map((template) => ({ value: template.id, label: template.name }))} />
        <ThemedText type="small">Пункты шаблона будут скопированы в новую независимую задачу.</ThemedText>
      </>}
    </Card> : null}
    <Input label="Название" placeholder="Название задачи" value={title} onChangeText={setTitle} />
    <Textarea label="Описание" placeholder="Необязательно" value={description} onChangeText={setDescription} />
    <ErrorMessage message={error} type="auth" />
    <Button loading={busy} disabled={busy || (mode === 'template' && !templateId)} onPress={submit}>Создать</Button>
    <Button variant="outline" onPress={() => router.back()}>Отмена</Button>
  </Screen>;
}
