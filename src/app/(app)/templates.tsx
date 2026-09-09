import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen } from '@/components/ui/screen';
import { PageHeader } from '@/components/ui/page-header';
import { ThemedText } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { archiveTaskTemplate, createTaskTemplate, createTaskTemplateItem, deleteTaskTemplateItem, listTaskTemplateItems, listTaskTemplates, updateTaskTemplate, updateTaskTemplateItem, type TaskTemplate, type TaskTemplateItem } from '@/features/projects/projects';
import { getCurrentUser } from '@/features/auth/auth';
import { layout, spacing } from '@/components/ui/theme';

export default function TemplatesScreen() {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [selected, setSelected] = useState<TaskTemplate | null>(null);
  const [items, setItems] = useState<TaskTemplateItem[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [newItem, setNewItem] = useState('');
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editingItemTitle, setEditingItemTitle] = useState('');
  const [editingItemDescription, setEditingItemDescription] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const selectedId = selected?.id;
  const canEditSelected = Boolean(selected && currentUserId === selected.created_by);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [{ data }, rows] = await Promise.all([getCurrentUser(), listTaskTemplates()]);
      setCurrentUserId(data.user?.id ?? null);
      setTemplates(rows);
      if (selectedId) {
        const fresh = rows.find((row) => row.id === selectedId) ?? null;
        setSelected(fresh);
        setItems(fresh ? await listTaskTemplateItems(fresh.id) : []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось загрузить шаблоны.');
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try { await action(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Операция не выполнена.'); }
    finally { setBusy(false); }
  }

  function selectTemplate(template: TaskTemplate) {
    setSelected(template);
    setEditName(template.name);
    setEditDescription(template.description ?? '');
    setEditingItem(null);
    void listTaskTemplateItems(template.id).then(setItems).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить пункты.'));
  }

  return <Screen padded={false} centerContent={false}>
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <PageHeader title="Глобальные шаблоны" subtitle="Общие заготовки задач" onBack={() => router.back()} />
      {error ? <ErrorState message={error} onRetry={load} /> : null}
      <Card>
        <ThemedText type="h2">Новый шаблон</ThemedText>
        <Input label="Название" value={createName} onChangeText={setCreateName} maxLength={200} placeholder="Подготовка релиза" />
        <Textarea label="Описание" value={createDescription} onChangeText={setCreateDescription} maxLength={10000} placeholder="Необязательно" />
        <Button disabled={busy || !createName.trim()} onPress={() => void run(async () => { await createTaskTemplate(createName.trim(), createDescription); setCreateName(''); setCreateDescription(''); })}>Создать шаблон</Button>
      </Card>
      {loading && !templates.length ? <LoadingState /> : !templates.length ? <EmptyState title="Шаблонов пока нет" description="Создайте первый глобальный шаблон." /> : <View style={styles.list}>
        {templates.map((template) => <Card key={template.id} onPress={() => selectTemplate(template)}>
          <View style={styles.row}><ThemedText type="h3" style={styles.flex}>{template.name}</ThemedText><ThemedText type="caption">{template.item_count} пунктов</ThemedText></View>
          {template.description ? <ThemedText type="small">{template.description}</ThemedText> : null}
          {currentUserId === template.created_by ? <Button size="sm" variant="destructive" disabled={busy} onPress={() => void run(() => archiveTaskTemplate(template.id))}>Архивировать</Button> : null}
        </Card>)}
      </View>}
      {selected ? <Card>
        <View style={styles.row}><ThemedText type="h2" style={styles.flex}>{selected.name}</ThemedText><ThemedText type="caption">{canEditSelected ? 'Можно редактировать' : 'Только просмотр'}</ThemedText></View>
        {canEditSelected ? <>
          <Input label="Название" value={editName} onChangeText={setEditName} maxLength={200} />
          <Textarea label="Описание" value={editDescription} onChangeText={setEditDescription} maxLength={10000} />
          <Button disabled={busy || !editName.trim()} onPress={() => void run(() => updateTaskTemplate(selected.id, editName.trim(), editDescription))}>Сохранить шаблон</Button>
        </> : null}
        <View style={styles.list}>{items.map((item, index) => <View key={item.id} style={styles.item}>
          {editingItem === item.id ? <View style={styles.editItem}><Input value={editingItemTitle} onChangeText={setEditingItemTitle} maxLength={500} /><Textarea label="Описание пункта" value={editingItemDescription} onChangeText={setEditingItemDescription} maxLength={10000} /></View> : <View style={styles.flex}><ThemedText>{index + 1}. {item.title}</ThemedText>{item.description ? <ThemedText type="small">{item.description}</ThemedText> : null}</View>}
          {canEditSelected ? <>
            {editingItem === item.id ? <Button size="sm" disabled={busy || !editingItemTitle.trim()} onPress={() => void run(async () => { await updateTaskTemplateItem(item.id, editingItemTitle.trim(), editingItemDescription, item.position); setEditingItem(null); })}>Сохранить</Button> : <Button size="sm" variant="ghost" disabled={busy} onPress={() => { setEditingItem(item.id); setEditingItemTitle(item.title); setEditingItemDescription(item.description ?? ''); }}>Изменить</Button>}
            <Button size="sm" variant="ghost" disabled={busy || index === 0} onPress={() => void run(() => updateTaskTemplateItem(item.id, item.title, item.description ?? undefined, item.position - 1))}>Вверх</Button>
            <Button size="sm" variant="ghost" disabled={busy || index === items.length - 1} onPress={() => void run(() => updateTaskTemplateItem(item.id, item.title, item.description ?? undefined, item.position + 1))}>Вниз</Button>
            <Button size="sm" variant="ghost" disabled={busy} onPress={() => void run(() => deleteTaskTemplateItem(item.id))}>Удалить</Button>
          </> : null}
        </View>)}</View>
        {canEditSelected ? <View style={styles.actions}><Input label="Новый пункт" value={newItem} onChangeText={setNewItem} maxLength={500} placeholder="Проверить сборку" /><Button disabled={busy || !newItem.trim()} onPress={() => void run(async () => { await createTaskTemplateItem(selected.id, newItem.trim(), undefined, items.length + 1); setNewItem(''); })}>Добавить пункт</Button></View> : null}
      </Card> : null}
    </ScrollView>
  </Screen>;
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: layout.appMaxWidth, alignSelf: 'center', padding: spacing.xl, gap: spacing.lg },
  list: { gap: spacing.md },
  item: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  flex: { flex: 1, minWidth: 140 },
  actions: { gap: spacing.sm },
  editItem: { flex: 1, minWidth: 220, gap: spacing.sm },
});
