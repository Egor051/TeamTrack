import { beforeEach, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { createElement } from 'react';
const f = vi.hoisted(() => ({ rows: [] as { id: string; title: string; description: string; position: number }[], rpc: vi.fn() }));
const template = '00000000-0000-4000-8000-000000000010';
vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', Pressable: 'Pressable', StyleSheet: { create: (value: unknown) => value } }));
vi.mock('expo-router', async () => { const React = await import('react'); return { useFocusEffect: (callback: () => void) => React.useEffect(callback, [callback]) }; });
vi.mock('@/lib/connectivity/use-online-recovery', () => ({ useOnlineRecovery: () => undefined }));
vi.mock('@/features/auth/auth', () => ({ getCurrentUser: async () => ({ data: { user: { id: '00000000-0000-4000-8000-000000000011' } }, error: null }) }));
vi.mock('@/lib/supabase/client', () => ({ supabase: { rpc: f.rpc } }));
vi.mock('@/features/projects/projects', async (importOriginal) => ({ ...await importOriginal<typeof import('@/features/projects/projects')>(),
  listTaskTemplates: async () => [{ id: '00000000-0000-4000-8000-000000000010', name: 'Template', created_by: '00000000-0000-4000-8000-000000000011' }],
  listTaskTemplateItems: async () => structuredClone(f.rows),
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
import TemplatesScreen from '@/app/(app)/templates';
beforeEach(() => {
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
