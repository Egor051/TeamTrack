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
import { createTaskTemplate, createTaskTemplateItem, deleteTaskTemplateItem, listTaskTemplateItems, listTaskTemplates, updateTaskTemplate, updateTaskTemplateItem, archiveTaskTemplate, type TaskTemplate, type TaskTemplateItem } from '@/features/projects/projects';
import { layout, spacing } from '@/components/ui/theme';

export default function TemplatesScreen() {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [selected, setSelected] = useState<TaskTemplate | null>(null);
  const [items, setItems] = useState<TaskTemplateItem[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [newItem, setNewItem] = useState('');
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editingItemTitle, setEditingItemTitle] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const selectedId = selected?.id;
  const load = useCallback(async () => { setLoading(true); try { const rows = await listTaskTemplates(); setTemplates(rows); if (selectedId) { const fresh = rows.find((row) => row.id === selectedId) || null; setSelected(fresh); if (fresh) setItems(await listTaskTemplateItems(fresh.id)); } } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось загрузить шаблоны.'); } finally { setLoading(false); } }, [selectedId]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  async function run(action: () => Promise<unknown>) { setBusy(true); setError(''); try { await action(); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Операция не выполнена.'); } finally { setBusy(false); } }
  function selectTemplate(template: TaskTemplate) { setSelected(template); setName(template.name); setDescription(template.description || ''); void listTaskTemplateItems(template.id).then(setItems).catch((e) => setError(e instanceof Error ? e.message : 'Не удалось загрузить пункты.')); }
  return <Screen padded={false} centerContent={false}><ScrollView contentContainerStyle={styles.content}>
    <PageHeader title="Глобальные шаблоны" subtitle="Общие заготовки задач для всех проектов" onBack={() => router.back()} />
    {error ? <ErrorState message={error} onRetry={load} /> : null}
    <Card><ThemedText type="h2">Новый шаблон</ThemedText><Input label="Название" value={name} onChangeText={setName} placeholder="Подготовка релиза" /><Textarea label="Описание" value={description} onChangeText={setDescription} placeholder="Необязательно" /><View style={styles.actions}><Button disabled={busy || !name.trim()} onPress={() => void run(async () => { const id = await createTaskTemplate(name.trim(), description.trim()); const next = { id, name: name.trim(), description: description.trim() || null } as TaskTemplate; setSelected(next); setName(''); setDescription(''); })}>Создать шаблон</Button>{selected ? <Button variant="outline" disabled={busy || !name.trim()} onPress={() => void run(() => updateTaskTemplate(selected.id, name.trim(), description.trim()))}>Сохранить выбранный</Button> : null}</View></Card>
    {loading && !templates.length ? <LoadingState /> : !templates.length ? <EmptyState title="Шаблонов пока нет" description="Создайте первый глобальный шаблон." /> : <View style={styles.list}>{templates.map((template) => <Card key={template.id} onPress={() => selectTemplate(template)}><ThemedText type="h3">{template.name}</ThemedText>{template.description ? <ThemedText type="small">{template.description}</ThemedText> : null}<Button size="sm" variant="ghost" disabled={busy} onPress={() => void run(() => archiveTaskTemplate(template.id))}>Архивировать</Button></Card>)}</View>}
    {selected ? <Card><ThemedText type="h2">Пункты: {selected.name}</ThemedText><View style={styles.list}>{items.map((item, index) => <View key={item.id} style={styles.item}>{editingItem === item.id ? <Input value={editingItemTitle} onChangeText={setEditingItemTitle} /> : <ThemedText style={styles.flex}>{index + 1}. {item.title}</ThemedText>}{editingItem === item.id ? <Button size="sm" disabled={busy || !editingItemTitle.trim()} onPress={() => void run(async () => { await updateTaskTemplateItem(item.id, editingItemTitle.trim(), item.description || undefined, item.position); setEditingItem(null); })}>Сохранить</Button> : <Button size="sm" variant="ghost" disabled={busy} onPress={() => { setEditingItem(item.id); setEditingItemTitle(item.title); }}>Изменить</Button>}<Button size="sm" variant="ghost" disabled={busy || index === 0} onPress={() => void run(() => updateTaskTemplateItem(item.id, item.title, item.description || undefined, item.position - 1))}>Вверх</Button><Button size="sm" variant="ghost" disabled={busy || index === items.length - 1} onPress={() => void run(() => updateTaskTemplateItem(item.id, item.title, item.description || undefined, item.position + 1))}>Вниз</Button><Button size="sm" variant="ghost" disabled={busy} onPress={() => void run(() => deleteTaskTemplateItem(item.id))}>Удалить</Button></View>)}</View><View style={styles.actions}><Input label="Новый пункт" value={newItem} onChangeText={setNewItem} placeholder="Проверить сборку" /><Button disabled={busy || !newItem.trim()} onPress={() => void run(async () => { await createTaskTemplateItem(selected.id, newItem.trim(), undefined, items.length + 1); setNewItem(''); setItems(await listTaskTemplateItems(selected.id)); })}>Добавить пункт</Button></View></Card> : null}
  </ScrollView></Screen>;
}
const styles = StyleSheet.create({ content: { width: '100%', maxWidth: layout.appMaxWidth, alignSelf: 'center', padding: spacing.xl, gap: spacing.lg }, list: { gap: spacing.md }, item: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm }, flex: { flex: 1, minWidth: 140 }, actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: spacing.sm } });
