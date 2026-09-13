import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Screen } from '@/components/ui/screen';
import { PageHeader } from '@/components/ui/page-header';
import { ThemedText } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { ErrorMessage } from '@/components/ui/error-message';
import { layout, spacing } from '@/components/ui/theme';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { createTask, createTaskFromTemplate, getProject, listTaskTemplates, type TaskTemplate } from '@/features/projects/projects';
import { userMessage } from '@/lib/errors/user-message';

type Draft = { title: string; description: string };

export default function NewTask() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [projectName, setProjectName] = useState('Проект');
  const [mode, setMode] = useState<'blank' | 'template'>('blank');
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [blankDraft, setBlankDraft] = useState<Draft>({ title: '', description: '' });
  const [templateDraft, setTemplateDraft] = useState<Draft>({ title: '', description: '' });
  const [error, setError] = useState('');
  const [templateError, setTemplateError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const templateRequestRef = useRef(0);
  const submitRef = useRef(false);
  const draft = mode === 'blank' ? blankDraft : templateDraft;
  const selectedTemplate = templates.find((template) => template.id === templateId);

  useEffect(() => {
    let current = true;
    if (id) void getProject(id).then((project) => { if (current) setProjectName(project.name); }).catch(() => undefined);
    return () => { current = false; };
  }, [id]);

  const loadTemplates = useCallback(async () => {
    const request = ++templateRequestRef.current;
    setLoadingTemplates(true);
    setTemplateError('');
    try {
      const rows = await listTaskTemplates();
      if (request !== templateRequestRef.current) return;
      setTemplates(rows);
    } catch (e) {
      if (request === templateRequestRef.current) setTemplateError(userMessage(e, 'Не удалось загрузить шаблоны.'));
    } finally {
      if (request === templateRequestRef.current) setLoadingTemplates(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    if (mode === 'template') void loadTemplates();
    return () => { templateRequestRef.current += 1; };
  }, [loadTemplates, mode]));

  function chooseTemplate(nextId: string) {
    if (busy || nextId === templateId) return;
    setTemplateId(nextId);
    const selected = templates.find((template) => template.id === nextId);
    setTemplateDraft({ title: selected?.name ?? '', description: selected?.description ?? '' });
    setError('');
  }

  function updateDraft(patch: Partial<Draft>) {
    const setDraft = mode === 'blank' ? setBlankDraft : setTemplateDraft;
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function submit() {
    if (submitRef.current || !id) return;
    if (!draft.title.trim()) return setError('Введите название задачи.');
    if (mode === 'template' && !selectedTemplate) return setError('Выберите шаблон.');
    submitRef.current = true;
    setBusy(true);
    setError('');
    try {
      const taskId = mode === 'template'
        ? await createTaskFromTemplate(id, templateId, draft.title.trim(), draft.description.trim())
        : await createTask(id, draft.title.trim(), draft.description.trim());
      router.replace(`/projects/${id}/tasks/${taskId}` as never);
    } catch (e) {
      setError(userMessage(e, 'Не удалось создать задачу. Попробуйте ещё раз.'));
    } finally {
      submitRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Screen scrollable centerContent={false} maxWidth={layout.readingMaxWidth} contentStyle={styles.content}>
      <PageHeader
        title="Новая задача"
        subtitle="Опишите результат, затем добавьте пункты чек-листа."
        onBack={() => router.replace(`/projects/${id}` as never)}
        backLabel="К проекту"
        breadcrumbs={[{ label: 'Проекты', href: '/projects' }, { label: projectName, href: `/projects/${id}` }, { label: 'Новая задача' }]}
      />
      <Card style={styles.form}>
        <ThemedText type="h2">Способ создания</ThemedText>
        <SegmentedControl
          value={mode}
          disabled={busy}
          onChange={(next) => { if (!busy) { setMode(next); setError(''); } }}
          accessibilityLabel="Способ создания задачи"
          options={[{ value: 'blank', label: 'С нуля' }, { value: 'template', label: 'Из шаблона' }]}
        />
        {mode === 'template' ? (
          <View style={styles.section}>
            {loadingTemplates && !templates.length ? <LoadingState label="Загружаем шаблоны…" /> : templateError && !templates.length ? (
              <ErrorState message={templateError} onRetry={loadTemplates} />
            ) : !templates.length ? (
              <EmptyState
                title="Шаблонов пока нет"
                description="Создайте шаблон для повторяющейся работы или выберите «С нуля»."
                actionLabel="Открыть шаблоны"
                onAction={() => router.push('/templates')}
              />
            ) : (
              <>
                {templateError ? <View style={styles.feedback}><ErrorMessage message={templateError} type="generic" /><Button size="sm" variant="outline" onPress={() => void loadTemplates()}>Обновить шаблоны</Button></View> : null}
                <Select
                  label="Шаблон задачи"
                  value={templateId}
                  disabled={busy}
                  onChange={chooseTemplate}
                  placeholder="Выберите шаблон"
                  accessibilityLabel="Выбор шаблона задачи"
                  options={templates.map((template) => ({ value: template.id, label: template.name }))}
                />
                <ThemedText type="small">
                  {selectedTemplate
                    ? `Пунктов в чек-листе: ${selectedTemplate.item_count}. Они будут скопированы в новую задачу. Название и описание можно изменить ниже.`
                    : 'Выберите готовый чек-лист. Новая задача будет независима от исходного шаблона.'}
                </ThemedText>
              </>
            )}
          </View>
        ) : <ThemedText type="small">Создайте пустую задачу и добавьте нужные пункты чек-листа.</ThemedText>}
        {mode === 'blank' || selectedTemplate ? (
          <View style={styles.section}>
            <Input
              label="Название задачи"
              placeholder="Например, подготовить макеты к передаче"
              value={draft.title}
              onChangeText={(title) => updateDraft({ title })}
              autoCapitalize="sentences"
              disabled={busy}
            />
            <Textarea
              label="Описание · необязательно"
              placeholder="Контекст, требования и ожидаемый результат"
              value={draft.description}
              onChangeText={(description) => updateDraft({ description })}
              autoCapitalize="sentences"
              disabled={busy}
            />
          </View>
        ) : null}
        <ErrorMessage message={error} type="validation" />
        <View style={styles.actions}>
          <Button
            loading={busy}
            disabled={busy || !draft.title.trim() || (mode === 'template' && (!selectedTemplate || loadingTemplates))}
            onPress={() => void submit()}
          >Создать задачу</Button>
          <Button variant="ghost" disabled={busy} onPress={() => router.replace(`/projects/${id}` as never)}>Отмена</Button>
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.xl },
  form: { gap: spacing.lg },
  section: { gap: spacing.lg },
  feedback: { gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
});
