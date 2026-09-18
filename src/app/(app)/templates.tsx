import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen } from '@/components/ui/screen';
import { PageHeader } from '@/components/ui/page-header';
import { ThemedText } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { ErrorMessage } from '@/components/ui/error-message';
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
import { userMessage } from '@/lib/errors/user-message';

export default function TemplatesScreen() {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedItems, setExpandedItems] = useState<TaskTemplateItem[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editSnapshot, setEditSnapshot] = useState<{ name: string; description: string } | null>(null);
  const [newItem, setNewItem] = useState('');
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const [editingItemTitle, setEditingItemTitle] = useState('');
  const [editingItemDescription, setEditingItemDescription] = useState('');
  const [templateToDelete, setTemplateToDelete] = useState<TaskTemplate | null>(null);
  const [itemToDelete, setItemToDelete] = useState<TaskTemplateItem | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [busy, setBusy] = useState(false);
  const itemRequestRef = useRef(0);
  const actionRef = useRef(false);

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
         setEditSnapshot({ name: fresh.name.trim(), description: (fresh.description ?? '').trim() });
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
      setError(userMessage(e, 'Не удалось загрузить шаблоны.'));
    } finally {
      setLoading(false);
    }
  }, [expandedId]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  async function run(action: () => Promise<unknown>) {
    if (actionRef.current) return;
    actionRef.current = true;
    setBusy(true);
    setError('');
    try {
      try {
        await action();
      } catch (e) {
        setError(userMessage(e, 'Операция не выполнена.'));
        return;
      }
      try {
        await load();
      } catch (e) {
        setError(userMessage(e, 'Не удалось обновить шаблоны.'));
      }
    } finally {
      actionRef.current = false;
      setBusy(false);
    }
  }

  function toggleTemplate(template: TaskTemplate) {
    if (busy) return;
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
      setEditSnapshot({ name: template.name.trim(), description: (template.description ?? '').trim() });
    setEditingItem(null);
    const itemRequest = ++itemRequestRef.current;
    setLoadingItems(true);
    void listTaskTemplateItems(template.id)
      .then((rows) => { if (itemRequest === itemRequestRef.current) setExpandedItems(rows); })
      .catch((e) => setError(userMessage(e, 'Не удалось загрузить пункты шаблона.')))
      .finally(() => { if (itemRequest === itemRequestRef.current) setLoadingItems(false); });
  }

  return (
    <Screen padded={false} centerContent={false}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <PageHeader title="Глобальные шаблоны" subtitle="Общие заготовки этапов" breadcrumbs={[{ label: 'Проекты', href: '/projects' }, { label: 'Шаблоны' }]} />
        {error ? <View style={styles.feedback}><ErrorMessage message={error} type="generic" /><Button size="sm" variant="outline" onPress={() => void load()}>Обновить шаблоны</Button></View> : null}
        <Card>
          <ThemedText type="h2">Новый шаблон</ThemedText>
          <Input label="Название" value={createName} onChangeText={setCreateName} maxLength={200} placeholder="Подготовка релиза" disabled={busy} />
          <Textarea label="Описание" value={createDescription} onChangeText={setCreateDescription} maxLength={10000} placeholder="Необязательно" disabled={busy} />
          <Button loading={busy} disabled={busy || !createName.trim()} onPress={() => void run(async () => { await createTaskTemplate(createName.trim(), createDescription); setCreateName(''); setCreateDescription(''); })}>Создать шаблон</Button>
        </Card>
        {loading && !templates.length ? <LoadingState /> : !templates.length ? <EmptyState title="Шаблонов пока нет" description="Создайте первый глобальный шаблон." /> : (
          <View style={styles.list}>
            {templates.map((template) => {
              const expanded = expandedId === template.id;
              const canEdit = currentUserId === template.created_by;
              return (
                <Card key={template.id}>
                  <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? 'Свернуть' : 'Раскрыть'} шаблон ${template.name}`} accessibilityState={{ expanded, disabled: busy }} disabled={busy} onPress={() => toggleTemplate(template)} style={({ pressed }) => [styles.summary, pressed && styles.pressed]}>
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
                        <Input label="Название" value={editName} onChangeText={setEditName} maxLength={200} disabled={busy} />
                        <Textarea label="Описание" value={editDescription} onChangeText={setEditDescription} maxLength={10000} disabled={busy} />
                         <Button loading={busy} disabled={busy || !editName.trim() || !editSnapshot || (editName.trim() === editSnapshot.name && editDescription.trim() === editSnapshot.description)} onPress={() => void run(() => updateTaskTemplate(template.id, editName.trim(), editDescription.trim()))}>Сохранить шаблон</Button>
                       </> : null}
                       {loadingItems ? <LoadingState label="Загружаем пункты..." /> : <View style={styles.list}>{expandedItems.map((item, index) => <View key={item.id} style={styles.item}>
                         <View style={styles.itemContent}>
                           {editingItem === item.id ? <View style={styles.editItem}><Input label="Название пункта" value={editingItemTitle} onChangeText={setEditingItemTitle} maxLength={500} disabled={busy} /><Textarea label="Описание пункта" value={editingItemDescription} onChangeText={setEditingItemDescription} maxLength={10000} disabled={busy} /></View> : <View style={styles.flex}><ThemedText>{index + 1}. {item.title}</ThemedText>{item.description ? <ThemedText type="small">{item.description}</ThemedText> : null}</View>}
                         </View>
                         {canEdit ? <View style={styles.itemActions}>
                           {editingItem === item.id ? <Button size="sm" loading={busy} disabled={busy || !editingItemTitle.trim()} onPress={() => void run(async () => { await updateTaskTemplateItem(item.id, editingItemTitle.trim(), editingItemDescription.trim(), item.position); setEditingItem(null); })}>Сохранить</Button> : <Button size="sm" variant="ghost" disabled={busy} onPress={() => { setEditingItem(item.id); setEditingItemTitle(item.title); setEditingItemDescription(item.description ?? ''); }}>Изменить</Button>}
                           <Button size="sm" variant="ghost" disabled={busy || index === 0} onPress={() => void run(() => updateTaskTemplateItem(item.id, item.title, item.description ?? undefined, index === 1 ? Math.max(0, expandedItems[index - 1].position - 1) : (expandedItems[index - 2].position + expandedItems[index - 1].position) / 2))}>Вверх</Button>
                           <Button size="sm" variant="ghost" disabled={busy || index === expandedItems.length - 1} onPress={() => void run(() => updateTaskTemplateItem(item.id, item.title, item.description ?? undefined, index === expandedItems.length - 2 ? expandedItems[index + 1].position + 1 : (expandedItems[index + 1].position + expandedItems[index + 2].position) / 2))}>Вниз</Button>
                           <Button size="sm" variant="ghost" disabled={busy} onPress={() => setItemToDelete(item)}>Удалить</Button>
                         </View> : null}
                       </View>)}</View>}
                      {canEdit ? <View style={styles.actions}><Input label="Новый пункт" value={newItem} onChangeText={setNewItem} maxLength={500} placeholder="Проверить сборку" disabled={busy} /><Button loading={busy} disabled={busy || !newItem.trim()} onPress={() => void run(async () => { await createTaskTemplateItem(template.id, newItem.trim(), undefined, expandedItems.length + 1); setNewItem(''); })}>Добавить пункт</Button></View> : null}
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
          void run(async () => {
            await deleteTaskTemplate(template.id);
            setTemplateToDelete(null);
          });
        }}
      />
      <ConfirmDialog
        visible={Boolean(itemToDelete)}
        title="Удалить пункт шаблона?"
        description={`Пункт «${itemToDelete?.title ?? ''}» будет удалён из шаблона без возможности восстановления.`}
        confirmLabel="Удалить пункт"
        busy={busy}
        onCancel={() => setItemToDelete(null)}
        onConfirm={() => {
          const item = itemToDelete;
          if (!item) return;
          void run(async () => {
            await deleteTaskTemplateItem(item.id);
            setItemToDelete(null);
          });
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
  item: { gap: spacing.sm, minWidth: 0 },
  itemContent: { minWidth: 0 },
  itemActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  flex: { flex: 1, minWidth: 0 },
  actions: { gap: spacing.sm },
  feedback: { gap: spacing.sm },
  pressed: { opacity: 0.72 },
  editItem: { flex: 1, minWidth: 0, gap: spacing.sm },
});
