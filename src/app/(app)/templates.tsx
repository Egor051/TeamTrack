import { useReadModelUpdates } from '@/lib/local-cache/use-read-model-updates';
import { useOnlineRecovery } from '@/lib/connectivity/use-online-recovery';
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
  moveTaskTemplateItem,
  type TaskTemplate,
  type TaskTemplateItem,
} from '@/features/projects/projects';
import { getCurrentUser } from '@/features/auth/auth';
import { layout, spacing } from '@/components/ui/theme';
import { mutationUserMessage, userMessage } from '@/lib/errors/user-message';
import { draftChanged, draftConflicts, useTextDraft } from '@/features/projects/use-text-draft';
import { subscribeMany } from '@/lib/supabase/realtime';

export default function TemplatesScreen() {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedItems, setExpandedItems] = useState<TaskTemplateItem[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const { draft, begin, accept, change, cancel, rebase } = useTextDraft();
  const editName = draft?.name ?? '';
  const editDescription = draft?.description ?? '';
  const [newItem, setNewItem] = useState('');
  const [editingItem, setEditingItem] = useState<string | null>(null);
  const { draft: itemDraft, begin: beginItem, accept: acceptItem, change: changeItem, rebase: rebaseItem } = useTextDraft();
  const editingItemTitle = itemDraft?.name ?? '';
  const editingItemDescription = itemDraft?.description ?? '';
  const [templateToDelete, setTemplateToDelete] = useState<TaskTemplate | null>(null);
  const [itemToDelete, setItemToDelete] = useState<TaskTemplateItem | null>(null);
  const [dialogError, setDialogError] = useState<{ target: string; message: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [busy, setBusy] = useState(false);
  const itemRequestRef = useRef(0);
  const loadRequestRef = useRef(0);
  const actionRef = useRef(false);

  const load = useCallback(async () => {
    const request = ++loadRequestRef.current;
    setLoading(true);
    setError('');
    try {
      const [{ data }, rows] = await Promise.all([getCurrentUser(), listTaskTemplates()]);
      if (request !== loadRequestRef.current) return;
      setCurrentUserId(data.user?.id ?? null);
      setTemplates(rows);
      if (expandedId) {
        const fresh = rows.find((row) => row.id === expandedId) ?? null;
        if (!fresh) {
          setExpandedId(null);
          setExpandedItems([]);
          cancel();
          return;
        }
        accept(fresh);
        const itemRequest = ++itemRequestRef.current;
        setLoadingItems(true);
        try {
          const rows = await listTaskTemplateItems(fresh.id);
          if (itemRequest === itemRequestRef.current && expandedId === fresh.id) {
            setExpandedItems(rows);
            const edited = rows.find((row) => row.id === editingItem);
            if (edited) acceptItem({ ...edited, name: edited.title });
          }
        } finally {
          if (itemRequest === itemRequestRef.current) setLoadingItems(false);
        }
      }
    } catch (e) {
      if (request === loadRequestRef.current) setError(userMessage(e, 'Не удалось загрузить шаблоны.'));
    } finally {
      if (request === loadRequestRef.current) setLoading(false);
    }
  }, [expandedId, editingItem, accept, cancel, acceptItem]);

  const { scheduleRefresh, refreshFromServer } = useReadModelUpdates(load, { view: 'templates' });
  useFocusEffect(useCallback(() => {
    if (!currentUserId) return;
    return subscribeMany(['task_templates', 'task_template_items'].map((table) => ({
      table, options: { templates: true, onEvent: scheduleRefresh,
        onStatus: (status) => { if (status === 'connected') scheduleRefresh(); } },
    })));
  }, [currentUserId, scheduleRefresh]));
  useOnlineRecovery(load);
  useFocusEffect(useCallback(() => { void load(); return () => { loadRequestRef.current += 1; itemRequestRef.current += 1; }; }, [load]));

  async function run(action: () => Promise<unknown>, dialogTarget?: string) {
    if (actionRef.current) return;
    actionRef.current = true;
    setBusy(true);
    setError('');
    setDialogError(null);
    try {
      try {
        await action();
      } catch (e) {
        const message = mutationUserMessage(e, 'Операция не выполнена.');
        if (dialogTarget) setDialogError({ target: dialogTarget, message }); else setError(message);
        if ((e as { code?: string })?.code === 'PT409') await refreshFromServer();
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
    loadRequestRef.current += 1;
    if (expandedId === template.id) {
      itemRequestRef.current += 1;
      setExpandedId(null);
      setExpandedItems([]);
      setEditingItem(null);
      cancel();
      return;
    }
    setExpandedId(template.id);
    setExpandedItems([]);
    begin(template);
    setEditingItem(null);
    const itemRequest = ++itemRequestRef.current;
    setLoadingItems(true);
    void listTaskTemplateItems(template.id)
      .then((rows) => { if (itemRequest === itemRequestRef.current) setExpandedItems(rows); })
      .catch((e) => { if (itemRequest === itemRequestRef.current) setError(userMessage(e, 'Не удалось загрузить пункты шаблона.')); })
      .finally(() => { if (itemRequest === itemRequestRef.current) setLoadingItems(false); });
  }

  return (
    <Screen padded={false} centerContent={false}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <PageHeader title="Глобальные шаблоны" subtitle="Общие заготовки этапов" breadcrumbs={[{ label: 'Проекты', href: '/projects' }, { label: 'Шаблоны' }]} />
        {error ? <View style={styles.feedback}><ErrorMessage message={error} type="generic" /><Button size="sm" variant="outline" onPress={() => void refreshFromServer()}>Обновить шаблоны</Button></View> : null}
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
                      <View style={styles.row}><ThemedText type="caption" style={styles.flex}>{canEdit ? 'Можно редактировать' : 'Только просмотр'}</ThemedText>{canEdit ? <Button size="sm" variant="destructive" disabled={busy} onPress={() => { setDialogError(null); setTemplateToDelete(template); }}>Удалить</Button> : null}</View>
                      {canEdit ? <>
                        <Input label="Название" value={editName} onChangeText={(name) => change({ name })} maxLength={200} disabled={busy} />
                        <Textarea label="Описание" value={editDescription} onChangeText={(description) => change({ description })} maxLength={10000} disabled={busy} />
                        {draftConflicts(draft, template) ? <View><ThemedText>Шаблон изменён. Ваш черновик сохранён. На сервере: «{template.name}», {template.description || 'без описания'}.</ThemedText><Button disabled={busy} onPress={() => rebase(template)}>Продолжить с моим черновиком</Button></View> : null}
                         <Button loading={busy} disabled={busy || !editName.trim() || !draft || !draftChanged(draft) || draftConflicts(draft, template)} onPress={() => void run(async () => { if (!draft) return; await updateTaskTemplate(template.id, editName.trim(), editDescription.trim(), draft.baseline); begin({ ...template, name: editName.trim(), description: editDescription.trim() }); })}>Сохранить шаблон</Button>
                       </> : null}
                       {loadingItems && !expandedItems.length ? <LoadingState label="Загружаем пункты..." /> : <View style={styles.list}>{expandedItems.map((item, index) => <View key={item.id} style={styles.item}>
                         <View style={styles.itemContent}>
                           {editingItem === item.id ? <View style={styles.editItem}><Input label="Название пункта" value={editingItemTitle} onChangeText={(name) => changeItem({ name })} maxLength={500} disabled={busy} /><Textarea label="Описание пункта" value={editingItemDescription} onChangeText={(description) => changeItem({ description })} maxLength={10000} disabled={busy} />{draftConflicts(itemDraft, { ...item, name: item.title }) ? <View><ThemedText>Пункт изменён. На сервере: «{item.title}», {item.description || 'без описания'}.</ThemedText><Button disabled={busy} onPress={() => rebaseItem({ ...item, name: item.title })}>Продолжить с моим черновиком</Button></View> : null}</View> : <View style={styles.flex}><ThemedText>{index + 1}. {item.title}</ThemedText>{item.description ? <ThemedText type="small">{item.description}</ThemedText> : null}</View>}
                         </View>
                         {canEdit ? <View style={styles.itemActions}>
                           {editingItem === item.id ? <><Button size="sm" loading={busy} disabled={busy || !editingItemTitle.trim() || !itemDraft || draftConflicts(itemDraft, { ...item, name: item.title })} onPress={() => void run(async () => { if (!itemDraft) return; await updateTaskTemplateItem(item.id, editingItemTitle.trim(), editingItemDescription.trim(), undefined, itemDraft.baseline); setEditingItem(null); })}>Сохранить</Button><Button size="sm" variant="ghost" disabled={busy} onPress={() => setEditingItem(null)}>Отмена</Button></> : <Button size="sm" variant="ghost" disabled={busy} onPress={() => { setEditingItem(item.id); beginItem({ ...item, name: item.title }); }}>Изменить</Button>}
                           <Button size="sm" variant="ghost" disabled={busy || index === 0} onPress={() => void run(() => moveTaskTemplateItem(item.id, -1))}>Вверх</Button>
                           <Button size="sm" variant="ghost" disabled={busy || index === expandedItems.length - 1} onPress={() => void run(() => moveTaskTemplateItem(item.id, 1))}>Вниз</Button>
                           <Button size="sm" variant="ghost" disabled={busy} onPress={() => { setDialogError(null); setItemToDelete(item); }}>Удалить</Button>
                         </View> : null}
                       </View>)}</View>}
                      {canEdit ? <View style={styles.actions}><Input label="Новый пункт" value={newItem} onChangeText={setNewItem} maxLength={500} placeholder="Проверить сборку" disabled={busy} /><Button loading={busy} disabled={busy || !newItem.trim()} onPress={() => void run(async () => { await createTaskTemplateItem(template.id, newItem.trim()); setNewItem(''); })}>Добавить пункт</Button></View> : null}
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
        error={dialogError?.target === `template:${templateToDelete?.id}` ? dialogError.message : undefined}
        onCancel={() => { setTemplateToDelete(null); setDialogError(null); }}
        onConfirm={() => {
          const template = templateToDelete;
          if (!template) return;
          void run(async () => {
            await deleteTaskTemplate(template.id);
            setTemplateToDelete(null);
          }, `template:${template.id}`);
        }}
      />
      <ConfirmDialog
        visible={Boolean(itemToDelete)}
        title="Удалить пункт шаблона?"
        description={`Пункт «${itemToDelete?.title ?? ''}» будет удалён из шаблона без возможности восстановления.`}
        confirmLabel="Удалить пункт"
        busy={busy}
        error={dialogError?.target === `item:${itemToDelete?.id}` ? dialogError.message : undefined}
        onCancel={() => { setItemToDelete(null); setDialogError(null); }}
        onConfirm={() => {
          const item = itemToDelete;
          if (!item) return;
          void run(async () => {
            await deleteTaskTemplateItem(item.id);
            setItemToDelete(null);
          }, `item:${item.id}`);
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
