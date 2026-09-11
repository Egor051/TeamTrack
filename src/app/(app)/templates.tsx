import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen } from '@/components/ui/screen';
import { PageHeader } from '@/components/ui/page-header';
import { ThemedText } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import {
  createTaskTemplate,
  createTaskTemplateItem,
  deleteTaskTemplate,
  deleteTaskTemplateItem,
  listTaskTemplateItems,
  listTaskTemplates,
  updateTaskTemplate,
  updateTaskTemplateItem,
  type TaskTemplate,
  type TaskTemplateItem,
} from '@/features/projects/projects';
import { getCurrentUser } from '@/features/auth/auth';
import { layout, spacing } from '@/components/ui/theme';

export default function TemplatesScreen() {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedItems, setExpandedItems] = useState<TaskTemplateItem[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [newItem, setNewItem] = useState('');
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editingItemTitle, setEditingItemTitle] = useState('');
  const [editingItemDescription, setEditingItemDescription] = useState('');
  const [templateToDelete, setTemplateToDelete] = useState<TaskTemplate | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [busy, setBusy] = useState(false);
  const itemRequestRef = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [{ data }, rows] = await Promise.all([getCurrentUser(), listTaskTemplates()]);
      setCurrentUserId(data.user?.id ?? null);
      setTemplates(rows);
      if (expandedId) {
        const fresh = rows.find((row) => row.id === expandedId) ?? null;
        if (!fresh) {
          setExpandedId(null);
          setExpandedItems([]);
          return;
        }
        setEditName(fresh.name);
        setEditDescription(fresh.description ?? '');
        const itemRequest = ++itemRequestRef.current;
        setLoadingItems(true);
        try {
          const rows = await listTaskTemplateItems(fresh.id);
          if (itemRequest === itemRequestRef.current && expandedId === fresh.id) setExpandedItems(rows);
        } finally {
          if (itemRequest === itemRequestRef.current) setLoadingItems(false);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить шаблоны.');
    } finally {
      setLoading(false);
    }
  }, [expandedId]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Операция не выполнена.');
    } finally {
      setBusy(false);
    }
  }

  function toggleTemplate(template: TaskTemplate) {
    if (expandedId === template.id) {
      itemRequestRef.current += 1;
      setExpandedId(null);
      setExpandedItems([]);
      setEditingItem(null);
      return;
    }
    setExpandedId(template.id);
    setExpandedItems([]);
    setEditName(template.name);
    setEditDescription(template.description ?? '');
    setEditingItem(null);
    const itemRequest = ++itemRequestRef.current;
    setLoadingItems(true);
    void listTaskTemplateItems(template.id)
      .then((rows) => { if (itemRequest === itemRequestRef.current) setExpandedItems(rows); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить пункты.'))
      .finally(() => { if (itemRequest === itemRequestRef.current) setLoadingItems(false); });
  }

  return (
    <Screen padded={false} centerContent={false}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <PageHeader title="Глобальные шаблоны" subtitle="Общие заготовки задач" onBack={() => router.back()} />
        {error ? <ErrorState message={error} onRetry={load} /> : null}
        <Card>
          <ThemedText type="h2">Новый шаблон</ThemedText>
          <Input label="Название" value={createName} onChangeText={setCreateName} maxLength={200} placeholder="Подготовка релиза" />
          <Textarea label="Описание" value={createDescription} onChangeText={setCreateDescription} maxLength={10000} placeholder="Необязательно" />
          <Button disabled={busy || !createName.trim()} onPress={() => void run(async () => { await createTaskTemplate(createName.trim(), createDescription); setCreateName(''); setCreateDescription(''); })}>Создать шаблон</Button>
        </Card>
        {loading && !templates.length ? <LoadingState /> : !templates.length ? <EmptyState title="Шаблонов пока нет" description="Создайте первый глобальный шаблон." /> : (
          <View style={styles.list}>
            {templates.map((template) => {
              const expanded = expandedId === template.id;
              const canEdit = currentUserId === template.created_by;
              return (
                <Card key={template.id}>
                  <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? 'Свернуть' : 'Раскрыть'} шаблон ${template.name}`} onPress={() => toggleTemplate(template)} style={styles.summary}>
                    <View style={styles.row}>
                      <ThemedText type="h3" style={styles.flex}>{template.name}</ThemedText>
                      <ThemedText type="caption">{template.item_count} пунктов {expanded ? '▴' : '▾'}</ThemedText>
                    </View>
                    {template.description ? <ThemedText type="small">{template.description}</ThemedText> : null}
                  </Pressable>
                  {expanded ? (
                    <View style={styles.details}>
                      <View style={styles.row}><ThemedText type="caption" style={styles.flex}>{canEdit ? 'Можно редактировать' : 'Только просмотр'}</ThemedText>{canEdit ? <Button size="sm" variant="destructive" disabled={busy} onPress={() => setTemplateToDelete(template)}>Удалить</Button> : null}</View>
                      {canEdit ? <>
                        <Input label="Название" value={editName} onChangeText={setEditName} maxLength={200} />
                        <Textarea label="Описание" value={editDescription} onChangeText={setEditDescription} maxLength={10000} />
                        <Button disabled={busy || !editName.trim()} onPress={() => void run(() => updateTaskTemplate(template.id, editName.trim(), editDescription))}>Сохранить шаблон</Button>
                      </> : null}
                      {loadingItems ? <LoadingState label="Загружаем пункты..." /> : <View style={styles.list}>{expandedItems.map((item, index) => <View key={item.id} style={styles.item}>
                        {editingItem === item.id ? <View style={styles.editItem}><Input value={editingItemTitle} onChangeText={setEditingItemTitle} maxLength={500} /><Textarea label="Описание пункта" value={editingItemDescription} onChangeText={setEditingItemDescription} maxLength={10000} /></View> : <View style={styles.flex}><ThemedText>{index + 1}. {item.title}</ThemedText>{item.description ? <ThemedText type="small">{item.description}</ThemedText> : null}</View>}
                        {canEdit ? <>
                          {editingItem === item.id ? <Button size="sm" disabled={busy || !editingItemTitle.trim()} onPress={() => void run(async () => { await updateTaskTemplateItem(item.id, editingItemTitle.trim(), editingItemDescription, item.position); setEditingItem(null); })}>Сохранить</Button> : <Button size="sm" variant="ghost" disabled={busy} onPress={() => { setEditingItem(item.id); setEditingItemTitle(item.title); setEditingItemDescription(item.description ?? ''); }}>Изменить</Button>}
                          <Button size="sm" variant="ghost" disabled={busy || index === 0} onPress={() => void run(() => updateTaskTemplateItem(item.id, item.title, item.description ?? undefined, item.position - 1))}>Вверх</Button>
                          <Button size="sm" variant="ghost" disabled={busy || index === expandedItems.length - 1} onPress={() => void run(() => updateTaskTemplateItem(item.id, item.title, item.description ?? undefined, item.position + 1))}>Вниз</Button>
                          <Button size="sm" variant="ghost" disabled={busy} onPress={() => void run(() => deleteTaskTemplateItem(item.id))}>Удалить</Button>
                        </> : null}
                      </View>)}</View>}
                      {canEdit ? <View style={styles.actions}><Input label="Новый пункт" value={newItem} onChangeText={setNewItem} maxLength={500} placeholder="Проверить сборку" /><Button disabled={busy || !newItem.trim()} onPress={() => void run(async () => { await createTaskTemplateItem(template.id, newItem.trim(), undefined, expandedItems.length + 1); setNewItem(''); })}>Добавить пункт</Button></View> : null}
                    </View>
                  ) : null}
                </Card>
              );
            })}
          </View>
        )}
      </ScrollView>
      <ConfirmDialog
        visible={Boolean(templateToDelete)}
        title="Удалить шаблон?"
        description={`Шаблон «${templateToDelete?.name ?? ''}» и его пункты будут удалены из доступного списка. Операция необратима для пользователя и не может быть отменена.`}
        confirmLabel="Удалить"
        busy={busy}
        onCancel={() => setTemplateToDelete(null)}
        onConfirm={() => {
          const template = templateToDelete;
          if (!template) return;
          setTemplateToDelete(null);
          void run(() => deleteTaskTemplate(template.id));
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: layout.appMaxWidth, alignSelf: 'center', padding: spacing.xl, gap: spacing.lg },
  list: { gap: spacing.md },
  details: { gap: spacing.md, marginTop: spacing.md },
  summary: { gap: spacing.sm },
  item: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flex: { flex: 1, minWidth: 140 },
  actions: { gap: spacing.sm },
  editItem: { flex: 1, minWidth: 220, gap: spacing.sm },
});
