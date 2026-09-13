import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Screen } from '@/components/ui/screen';
import { PageHeader } from '@/components/ui/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { ErrorMessage } from '@/components/ui/error-message';
import { ThemedText } from '@/components/ui/text';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useAuth } from '@/features/auth/AuthProvider';
import { radii, spacing } from '@/components/ui/theme';
import { listOwnedProjects, listProjectMembers, transferProjectOwnership, type ProjectWithRole, type ProjectMember } from '@/features/projects/projects';
import { userMessage } from '@/lib/errors/user-message';
import { useTheme, type ThemeMode } from '@/components/ui/theme-provider';

const roleLabels = { owner: 'Владелец', admin: 'Администратор', member: 'Участник', viewer: 'Наблюдатель' };

export default function ProfileScreen() {
  const { state, signOut, updateProfile } = useAuth();
  const theme = useTheme();
  const userId = state.user?.id;
  const [busyAction, setBusyAction] = useState<'save' | 'transfer' | 'logout' | null>(null);
  const actionRef = useRef(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [profileError, setProfileError] = useState('');
  const [profileSaved, setProfileSaved] = useState(false);
  const [ownedLoading, setOwnedLoading] = useState(true);
  const [ownedError, setOwnedError] = useState('');
  const [owned, setOwned] = useState<ProjectWithRole[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState('');
  const [target, setTarget] = useState<ProjectMember | null>(null);
  const [transferError, setTransferError] = useState('');
  const [transferSuccess, setTransferSuccess] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const ownedRequestRef = useRef(0);
  const membersRequestRef = useRef(0);
  const selected = owned.find((project) => project.id === selectedId) ?? null;
  const busy = busyAction !== null;

  const loadOwned = useCallback(async () => {
    if (!userId) { setOwned([]); setOwnedLoading(false); return; }
    const request = ++ownedRequestRef.current;
    setOwnedLoading(true);
    setOwnedError('');
    try {
      const projects = await listOwnedProjects();
      if (request !== ownedRequestRef.current) return;
      setOwned(projects);
      setSelectedId((current) => projects.some((project) => project.id === current) ? current : null);
    } catch (e) {
      if (request === ownedRequestRef.current) setOwnedError(userMessage(e, 'Не удалось загрузить ваши проекты.'));
    } finally {
      if (request === ownedRequestRef.current) setOwnedLoading(false);
    }
  }, [userId]);

  useFocusEffect(useCallback(() => { void loadOwned(); return () => { ownedRequestRef.current += 1; }; }, [loadOwned]));
  useEffect(() => () => { membersRequestRef.current += 1; }, []);

  async function openTransfer(project: ProjectWithRole) {
    if (actionRef.current) return;
    const request = ++membersRequestRef.current;
    setSelectedId(project.id);
    setTarget(null);
    setMembers([]);
    setMembersError('');
    setTransferError('');
    setTransferSuccess('');
    setMembersLoading(project.status !== 'archived');
    if (project.status === 'archived') return;
    try {
      const next = await listProjectMembers(project.id);
      if (request !== membersRequestRef.current) return;
      const seen = new Set<string>();
      setMembers(next.filter((member) => {
        if (member.role === 'owner' || member.user_id === userId || seen.has(member.user_id)) return false;
        seen.add(member.user_id);
        return true;
      }));
    } catch (e) {
      if (request === membersRequestRef.current) setMembersError(userMessage(e, 'Не удалось загрузить участников проекта.'));
    } finally {
      if (request === membersRequestRef.current) setMembersLoading(false);
    }
  }

  async function save() {
    if (actionRef.current) return;
    const value = name.trim();
    if (value.length < 2 || value.length > 80) { setProfileError('Ник должен содержать от 2 до 80 символов.'); return; }
    if (!/^[\p{L}\p{N}_ .-]+$/u.test(value)) { setProfileError('Используйте буквы, цифры, пробелы и символы _ . -'); return; }
    actionRef.current = true;
    setBusyAction('save');
    setProfileError('');
    try { await updateProfile(value); setEditing(false); setProfileSaved(true); }
    catch (e) { setProfileError(userMessage(e, 'Не удалось сохранить ник.')); }
    finally { actionRef.current = false; setBusyAction(null); }
  }

  async function transfer() {
    if (actionRef.current || !selected || !target || selected.status === 'archived' || membersLoading) return;
    actionRef.current = true;
    setBusyAction('transfer');
    setTransferError('');
    try {
      await transferProjectOwnership(selected.id, target.user_id);
      setTransferSuccess(`Владение проектом «${selected.name}» передано: ${target.profile?.display_name || target.user_id.slice(0, 8)}.`);
      setConfirm(false);
      setSelectedId(null);
      setTarget(null);
      setMembers([]);
      await loadOwned();
    } catch (e) {
      setConfirm(false);
      setTransferError(userMessage(e, 'Не удалось передать владение. Вы можете повторить попытку.'));
    } finally { actionRef.current = false; setBusyAction(null); }
  }

  async function logout() {
    if (actionRef.current) return;
    actionRef.current = true;
    setBusyAction('logout');
    setLogoutError('');
    try { await signOut(); setOwned([]); }
    catch (e) { setLogoutError(userMessage(e, 'Не удалось завершить сеанс.')); }
    finally { actionRef.current = false; setBusyAction(null); }
  }

  return <Screen scrollable centerContent={false} maxWidth={680} contentStyle={styles.content}>
    <PageHeader title="Профиль" subtitle="Ваш аккаунт, оформление и управление владением проектами." onBack={() => router.replace('/projects')} breadcrumbs={[{ label: 'Проекты', href: '/projects' }, { label: 'Профиль' }]} />
    <Card style={styles.section}>
      <View style={styles.identity}>
        <View style={[styles.avatar, { backgroundColor: theme.colors.primarySoft }]}><ThemedText type="h1" style={{ color: theme.colors.primary }}>{(state.profile?.display_name || state.user?.email || '?').slice(0, 1).toUpperCase()}</ThemedText></View>
        <View style={styles.identityText}><ThemedText type="h2">{state.profile?.display_name || 'Пользователь'}</ThemedText><ThemedText type="small" selectable>{state.user?.email}</ThemedText></View>
      </View>
      {editing ? <>
        <Input label="Ник" value={name} onChangeText={(value) => { setName(value); setProfileError(''); }} hint="От 2 до 80 символов. Это имя видят участники ваших проектов." error={profileError} autoFocus disabled={busy} maxLength={80} onSubmitEditing={() => void save()} returnKeyType="done" />
        <View style={styles.actions}>
          <Button loading={busyAction === 'save'} disabled={busy || !name.trim() || name.trim() === state.profile?.display_name} onPress={() => void save()}>Сохранить</Button>
          <Button variant="outline" disabled={busy} onPress={() => { setEditing(false); setProfileError(''); }}>Отмена</Button>
        </View>
      </> : <Button size="sm" variant="outline" style={styles.leading} disabled={busy} onPress={() => { setName(state.profile?.display_name || ''); setProfileError(''); setProfileSaved(false); setEditing(true); }}>Изменить ник</Button>}
      {profileSaved ? <ThemedText type="small" accessibilityLiveRegion="polite" style={{ color: theme.colors.success }}>Ник сохранён.</ThemedText> : null}
    </Card>
    <Card style={styles.section}>
      <View style={styles.heading}><ThemedText type="h2">Оформление</ThemedText><ThemedText type="small">Выберите тему или используйте настройки устройства.</ThemedText></View>
      <View style={styles.actions}>{(['light', 'dark', 'system'] as ThemeMode[]).map((mode) => <Button key={mode} size="sm" accessibilityState={{ selected: theme.mode === mode }} variant={theme.mode === mode ? 'primary' : 'outline'} onPress={() => theme.setMode(mode)}>{mode === 'light' ? 'Светлая' : mode === 'dark' ? 'Тёмная' : 'Как на устройстве'}</Button>)}</View>
    </Card>
    <Card style={styles.section}>
      <View style={styles.heading}><ThemedText type="h2">Передача владения</ThemedText><ThemedText type="small">Передайте управление проектом другому участнику. После подтверждения вы перестанете быть владельцем.</ThemedText></View>
      {transferSuccess ? <ThemedText type="small" accessibilityLiveRegion="polite" style={{ color: theme.colors.success }}>{transferSuccess}</ThemedText> : null}
      {ownedLoading && !owned.length ? <LoadingState label="Загружаем ваши проекты…" /> : ownedError && !owned.length ? <ErrorState message={ownedError} onRetry={() => void loadOwned()} /> : !owned.length ? <EmptyState title="Нет проектов для передачи" description="Здесь появятся проекты, владельцем которых вы являетесь." /> : <>
        {ownedError ? <><ErrorMessage message={ownedError} type="validation" /><Button variant="outline" size="sm" onPress={() => void loadOwned()}>Обновить проекты</Button></> : null}
        <ThemedText type="h3">1. Выберите проект</ThemedText>
        <View style={styles.choiceList}>{owned.map((project) => <ChoiceRow key={project.id} title={project.name} description={project.status === 'archived' ? 'В архиве · требуется восстановление' : 'Активный проект'} selected={selectedId === project.id} disabled={busy} onPress={() => void openTransfer(project)} />)}</View>
        {selected ? <View style={[styles.transferDetails, { borderTopColor: theme.colors.border }]}>
          {selected.status === 'archived' ? <>
            <ThemedText type="small">Проект «{selected.name}» в архиве. Сначала восстановите его на странице проекта.</ThemedText>
            <Button variant="outline" size="sm" onPress={() => router.push(`/projects/${selected.id}`)}>Открыть проект</Button>
          </> : <>
            <ThemedText type="h3">2. Выберите нового владельца</ThemedText>
            <ThemedText type="small">Участники проекта «{selected.name}»</ThemedText>
            {membersLoading ? <LoadingState label="Загружаем участников…" /> : membersError ? <ErrorState message={membersError} onRetry={() => void openTransfer(selected)} /> : !members.length ? <EmptyState title="Нет других участников" description="Сначала добавьте участника в проект, затем передайте ему владение." actionLabel="Открыть участников" onAction={() => router.push(`/projects/${selected.id}/members`)} /> : <View style={styles.choiceList}>{members.map((member) => <ChoiceRow key={member.user_id} title={member.profile?.display_name || member.user_id.slice(0, 8)} description={roleLabels[member.role]} selected={target?.user_id === member.user_id} disabled={busy} onPress={() => { setTarget(member); setTransferError(''); }} />)}</View>}
            <ErrorMessage message={transferError} type="validation" />
            <Button variant="destructive" disabled={!target || busy || membersLoading || Boolean(membersError)} onPress={() => setConfirm(true)}>Передать владение…</Button>
          </>}
        </View> : <ThemedText type="small">Выберите проект, чтобы увидеть доступных участников.</ThemedText>}
      </>}
    </Card>
    <Card style={styles.section}>
      <View style={styles.heading}><ThemedText type="h2">Сеанс</ThemedText><ThemedText type="small">Завершите сеанс на этом устройстве.</ThemedText></View>
      <ErrorMessage message={logoutError} type="auth" />
      <Button style={styles.leading} variant="outline" loading={busyAction === 'logout'} disabled={busy} onPress={() => void logout()}>Выйти из аккаунта</Button>
    </Card>
    <ConfirmDialog visible={confirm} title="Передать владение проектом?" description={`Новым владельцем проекта «${selected?.name || ''}» станет ${target?.profile?.display_name || target?.user_id.slice(0, 8) || 'выбранный участник'}. Вы больше не будете владельцем.`} confirmLabel="Передать владение" busy={busyAction === 'transfer'} onCancel={() => setConfirm(false)} onConfirm={() => void transfer()} />
  </Screen>;
}

function ChoiceRow({ title, description, selected, disabled, onPress }: { title: string; description: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return <Pressable accessibilityRole="radio" accessibilityLabel={`${title}. ${description}`} accessibilityState={{ checked: selected, disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.choice, { backgroundColor: selected ? colors.primarySoft : pressed ? colors.surfaceMuted : colors.surface, borderColor: selected ? colors.primary : colors.border }, disabled && styles.disabled]}>
    <View style={[styles.radio, { borderColor: selected ? colors.primary : colors.borderStrong }]}>{selected ? <View style={[styles.radioDot, { backgroundColor: colors.primary }]} /> : null}</View>
    <View style={styles.choiceText}><ThemedText style={styles.choiceTitle}>{title}</ThemedText><ThemedText type="caption">{description}</ThemedText></View>
  </Pressable>;
}

const styles = StyleSheet.create({
  content: { gap: spacing.xl },
  section: { gap: spacing.lg },
  heading: { gap: spacing.xs },
  identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  identityText: { flex: 1, minWidth: 0, gap: spacing.xs },
  avatar: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  leading: { alignSelf: 'flex-start' },
  choiceList: { gap: spacing.sm },
  choice: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderWidth: 1, borderRadius: radii.md, padding: spacing.md, minHeight: 64 },
  choiceText: { flex: 1, minWidth: 0, gap: spacing.xs },
  choiceTitle: { fontWeight: '600' },
  radio: { width: 20, height: 20, borderWidth: 2, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  radioDot: { width: 10, height: 10, borderRadius: 5 },
  transferDetails: { gap: spacing.md, paddingTop: spacing.lg, borderTopWidth: 1 },
  disabled: { opacity: 0.55 },
});
