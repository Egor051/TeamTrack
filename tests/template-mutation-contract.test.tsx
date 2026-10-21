import { beforeEach, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';
import TemplatesScreen from '@/app/(app)/templates';
const f = vi.hoisted(() => ({ rows: [] as { id: string; title: string; description: string; position: number }[], rpc: vi.fn(),
  name: 'Template', description: 'Description', refresh: null as null | (() => Promise<void>), itemGate: null as Promise<void> | null }));
const template = '00000000-0000-4000-8000-000000000010';
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable', StyleSheet: { create: (value: unknown) => value } }));
vi.mock('expo-router', async () => { const React = await import('react'); return { useFocusEffect: (callback: () => void) => React.useEffect(callback, [callback]) }; });
vi.mock('@/lib/connectivity/use-online-recovery', () => ({ useOnlineRecovery: () => undefined }));
vi.mock('@/lib/supabase/realtime', () => ({ subscribeMany: () => () => undefined }));
vi.mock('@/lib/local-cache/use-read-model-updates', () => ({ useReadModelUpdates: (load: () => Promise<void>) => { f.refresh = load; return { refreshFromServer: load }; } }));
vi.mock('@/features/auth/auth', () => ({ getCurrentUser: async () => ({ data: { user: { id: '00000000-0000-4000-8000-000000000011' } }, error: null }) }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { rpc: f.rpc } }));
// This suite verifies UI/RPC arguments; durable receipt behavior has its own
// tests with the real executor and IndexedDB.
vi.mock('@/lib/supabase/mutation', () => ({ executeMutation: (name: string, args: unknown) => f.rpc(name, args) }));
vi.mock('@/features/projects/projects', async (importOriginal) => ({ ...await importOriginal<typeof import('@/features/projects/projects')>(),
  listTaskTemplates: async () => [{ id: '00000000-0000-4000-8000-000000000010', name: f.name, description: f.description, created_by: '00000000-0000-4000-8000-000000000011' }],
  listTaskTemplateItems: async () => { if (f.itemGate) await f.itemGate; return structuredClone(f.rows); },
}));
vi.mock('@/components/ui/screen', () => ({ Screen: 'Screen' }));
vi.mock('@/components/ui/page-header', () => ({ PageHeader: 'PageHeader' }));
vi.mock('@/components/ui/card', () => ({ Card: 'Card' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/input', () => ({ Input: 'Input' }));
vi.mock('@/components/ui/textarea', () => ({ Textarea: 'Textarea' }));
vi.mock('@/components/ui/states', () => ({ EmptyState: 'EmptyState', LoadingState: 'LoadingState' }));
vi.mock('@/components/ui/error-message', () => ({ ErrorMessage: 'ErrorMessage' }));
vi.mock('@/components/ui/text', () => ({ ThemedText: 'ThemedText' }));
vi.mock('@/components/ui/confirm-dialog', () => ({ ConfirmDialog: 'ConfirmDialog' }));
beforeEach(() => {
  f.name = 'Template'; f.description = 'Description'; f.itemGate = null;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  f.rows = ['A','B','C'].map((title, i) => ({ id: `00000000-0000-4000-8000-00000000000${i+1}`, title, description: title, position: (i+1)*100 }));
  f.rpc.mockReset(); f.rpc.mockImplementation(async () => ({ data: 'created-item', error: null }));
});
async function opened() {
  let screen!: ReturnType<typeof create>;
  await act(async () => { screen = create(createElement(TemplatesScreen)); });
  await act(async () => { screen.root.find((node) => String(node.type) === 'Pressable').props.onPress(); });
  return screen;
}
it('AUD-05: add delegates append positioning to the server', async () => {
  const screen = await opened();
  await act(async () => { screen.root.findAll((node) => String(node.type) === 'Input').find((node) => node.props.label === 'Новый пункт')!.props.onChangeText('D'); });
  await act(async () => { screen.root.findAll((node) => String(node.type) === 'Button').find((node) => node.props.children === 'Добавить пункт')!.props.onPress(); });
  expect(f.rpc).toHaveBeenCalledWith('create_task_template_item', { p_template_id: template, p_title: 'D' });
  await act(async () => { screen.unmount(); });
});
it.each(['Вверх', 'Вниз'])('AUD-06/07: %s sends only direction and identity from a stale rendered row', async (label) => {
  const screen = await opened(); const id = f.rows[1].id;
  f.rows[1] = { ...f.rows[1], title: 'NEW', description: 'NEW', position: 1000 };
  await act(async () => { screen.root.findAll((node) => String(node.type) === 'Button').filter((node) => node.props.children === label)[1].props.onPress(); });
  expect(f.rpc).toHaveBeenCalledWith('move_task_template_item', { p_item_id: id, p_direction: label === 'Вверх' ? -1 : 1 });
  expect(f.rpc).not.toHaveBeenCalledWith('update_task_template_item', expect.anything());
  await act(async () => { screen.unmount(); });
});
it('B01: template refresh preserves a dirty draft, rebases pristine fields and requires explicit conflict resolution', async () => {
  const screen = await opened();
  const name = () => screen.root.findAllByType('Input' as never).filter((node) => node.props.label === 'Название')[1];
  const button = (label: string) => screen.root.findAllByType('Button' as never).find((node) => node.props.children === label)!;
  f.name = 'Fresh'; await act(async () => { await f.refresh!(); }); expect(name().props.value).toBe('Fresh');
  await act(async () => name().props.onChangeText('Local'));
  f.name = 'Concurrent'; await act(async () => { await f.refresh!(); });
  expect(name().props.value).toBe('Local'); expect(button('Сохранить шаблон').props.disabled).toBe(true);
  await act(async () => button('Продолжить с моим черновиком').props.onPress());
  f.rpc.mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'save failed' } });
  await act(async () => button('Сохранить шаблон').props.onPress()); expect(name().props.value).toBe('Local');
  await act(async () => button('Сохранить шаблон').props.onPress());
  expect(f.rpc).toHaveBeenCalledWith('update_task_template', {p_template_id:template,p_name:'Local',p_description:'Description',p_expected_name:'Concurrent',p_expected_description:'Description'});
  await act(async () => screen.unmount());
});
it('B01: a template-item edit survives background changes and uses server CAS without overwriting a concurrent edit', async () => {
  const screen = await opened();
  const button = (label: string) => screen.root.findAllByType('Button' as never).find((node) => node.props.children === label)!;
  await act(async () => button('Изменить').props.onPress());
  const title = () => screen.root.findAllByType('Input' as never).find((node) => node.props.label === 'Название пункта')!;
  await act(async () => title().props.onChangeText('Local item'));
  f.rows[0] = { ...f.rows[0], title: 'External item' };
  await act(async () => { await f.refresh!(); });
  expect(title().props.value).toBe('Local item'); expect(button('Сохранить').props.disabled).toBe(true);
  await act(async () => button('Продолжить с моим черновиком').props.onPress());
  await act(async () => button('Сохранить').props.onPress());
  expect(f.rpc).toHaveBeenCalledWith('update_task_template_item',{ p_item_id:f.rows[0].id,p_title:'Local item',p_description:'A',p_expected_title:'External item',p_expected_description:'A' });
  await act(async () => screen.unmount());
});
it('B01: a pending background item refresh keeps the editor mounted and usable', async () => {
  const screen = await opened();
  await act(async () => screen.root.findAllByType('Button' as never).find((node) => node.props.children === 'Изменить')!.props.onPress());
  let release!: () => void;
  f.itemGate = new Promise((resolve) => { release = resolve; });
  let refresh!: Promise<void>;
  await act(async () => { refresh = f.refresh!(); });
  const input = screen.root.findAllByType('Input' as never).find((node) => node.props.label === 'Название пункта');
  expect(input).toBeDefined();
  await act(async () => { input!.props.onChangeText('Typed during refresh'); release(); await refresh; });
  expect(screen.root.findAllByType('Input' as never).find((node) => node.props.label === 'Название пункта')!.props.value).toBe('Typed during refresh');
  await act(async () => screen.unmount());
});
