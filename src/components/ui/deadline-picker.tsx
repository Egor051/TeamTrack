import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View, type GestureResponderEvent } from 'react-native';
import { Button } from './button';
import { ThemedText } from './text';
import { SegmentedControl } from './segmented-control';
import { useTheme } from './theme-provider';
import { formatDeadline, formatUtcOffset, isFutureDeadline, localDeadlineCandidates } from '@/features/projects/deadlines';

type Step = 'date' | 'hour' | 'minute';
const FACE_SIZE = 252;
export function dialValue(x: number, y: number, mode: 'hour' | 'minute'): number {
  const turns = (Math.atan2(x - FACE_SIZE / 2, FACE_SIZE / 2 - y) / (2 * Math.PI) + 1) % 1;
  const slots = mode === 'hour' ? 12 : 60;
  const value = Math.round(turns * slots) % slots;
  return mode === 'hour' ? value || 12 : value;
}

export function DeadlinePicker({ value, busy, error, onCancel, onSave }: {
  value: string | null; busy: boolean; error?: string; onCancel: () => void; onSave: (iso: string) => Promise<void>;
}) {
  const { colors } = useTheme();
  const [initial] = useState(() => value ? new Date(value) : new Date(Date.now() + 60 * 60 * 1000));
  const [date, setDate] = useState({ year: initial.getFullYear(), month: initial.getMonth(), day: initial.getDate() });
  const [month, setMonth] = useState(new Date(initial.getFullYear(), initial.getMonth(), 1));
  const [hour, setHour] = useState(initial.getHours() % 12 || 12);
  const [minute, setMinute] = useState(initial.getMinutes());
  const [period, setPeriod] = useState<'AM' | 'PM'>(initial.getHours() >= 12 ? 'PM' : 'AM');
  const [offset, setOffset] = useState(initial.getTimezoneOffset());
  const [step, setStep] = useState<Step>('date');
  const [validation, setValidation] = useState('');
  const candidates = localDeadlineCandidates(date.year, date.month, date.day, hour, minute, period);
  const selected = candidates.find((candidate) => candidate.getTimezoneOffset() === offset) ?? candidates[0] ?? null;
  const selectedTime = selected?.getTime() ?? null;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [today] = useState(() => { const date = new Date(); date.setHours(0, 0, 0, 0); return date; });
  const first = (month.getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const moveMonth = (offset: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + offset, 1));
  const setFromDial = (event: GestureResponderEvent) => {
    if (busy || step === 'date') return;
    const next = dialValue(event.nativeEvent.locationX, event.nativeEvent.locationY, step);
    if (step === 'hour') setHour(next); else setMinute(next);
  };
  const handleConfirm = async () => {
    if (selectedTime === null) { setValidation('Это время недоступно из-за перевода часов. Выберите другое.'); return; }
    if (!isFutureDeadline(selectedTime)) { setValidation('Выберите дату и время в будущем.'); return; }
    setValidation(''); await onSave(new Date(selectedTime).toISOString());
  };
  const angle = ((step === 'hour' ? hour % 12 / 12 : minute / 60) * 360);
  return <Modal transparent animationType="fade" visible onRequestClose={() => { if (!busy) onCancel(); }}>
    <View style={[styles.backdrop, { backgroundColor: colors.overlay }]}>
      <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <ThemedText type="h3">{value ? 'Изменить дедлайн' : 'Установить дедлайн'}</ThemedText>
          <SegmentedControl value={step} onChange={setStep} disabled={busy} accessibilityLabel="Шаг выбора дедлайна"
            options={[{ value: 'date', label: 'Дата' }, { value: 'hour', label: 'Часы' }, { value: 'minute', label: 'Минуты' }]} />
          {step === 'date' ? <View style={styles.calendar}>
            <View style={styles.month}>
              <Button size="sm" variant="ghost" accessibilityLabel="Предыдущий месяц" disabled={busy} onPress={() => moveMonth(-1)}>‹</Button>
              <ThemedText style={styles.monthTitle}>{month.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}</ThemedText>
              <Button size="sm" variant="ghost" accessibilityLabel="Следующий месяц" disabled={busy} onPress={() => moveMonth(1)}>›</Button>
            </View>
            <View style={styles.days}>{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((label) => <View key={label} style={styles.dayCell}><ThemedText type="caption">{label}</ThemedText></View>)}</View>
            <View style={styles.days}>{Array.from({ length: first + days }, (_, index) => {
              const day = index - first + 1;
              if (day < 1) return <View key={index} style={styles.dayCell} />;
              const current = new Date(month.getFullYear(), month.getMonth(), day);
              const disabled = busy || current < today;
              const chosen = date.year === month.getFullYear() && date.month === month.getMonth() && date.day === day;
              return <Pressable key={index} accessibilityRole="button" accessibilityLabel={current.toLocaleDateString('ru-RU', { dateStyle: 'full' })}
                accessibilityState={{ selected: chosen, disabled }} disabled={disabled}
                onPress={() => { setDate({ year: month.getFullYear(), month: month.getMonth(), day }); setValidation(''); setStep('hour'); }}
                style={[styles.dayCell, chosen && { backgroundColor: colors.primarySoft }, disabled && styles.disabled]}>
                <ThemedText style={chosen ? { color: colors.primary, fontWeight: '700' } : undefined}>{day}</ThemedText>
              </Pressable>;
            })}</View>
          </View> : <View style={styles.clock}>
            <ThemedText type="small">{step === 'hour' ? 'Выберите часы' : 'Выберите минуты'}</ThemedText>
            <View style={[styles.face, { backgroundColor: colors.surfaceMuted }]} accessible accessibilityRole="adjustable"
              accessibilityLabel={step === 'hour' ? `Часы: ${hour}` : `Минуты: ${minute}`}
              accessibilityState={{ disabled: busy }}
              accessibilityValue={{ min: step === 'hour' ? 1 : 0, max: step === 'hour' ? 12 : 59, now: step === 'hour' ? hour : minute }}
              accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
              onAccessibilityAction={(event) => { if (busy) return; const offset = event.nativeEvent.actionName === 'increment' ? 1 : -1; if (step === 'hour') setHour((hour - 1 + offset + 12) % 12 + 1); else setMinute((minute + offset + 60) % 60); }}
              onStartShouldSetResponder={() => !busy} onResponderGrant={setFromDial} onResponderMove={setFromDial}
              onResponderRelease={() => { if (step === 'hour') setStep('minute'); }}>
              <View pointerEvents="none" style={[styles.hand, { backgroundColor: colors.primary, transform: [{ translateY: 47 }, { rotate: `${angle}deg` }, { translateY: -47 }] }]} />
              <View pointerEvents="none" style={[styles.hub, { backgroundColor: colors.primary }]} />
              {Array.from({ length: 12 }, (_, index) => {
                const radians = index * Math.PI / 6;
                const label = step === 'hour' ? index || 12 : index * 5;
                const chosen = step === 'hour' ? hour === label : minute === label;
                return <View pointerEvents="none" key={index} style={[styles.dialNumber, { left: 104 + Math.sin(radians) * 91, top: 104 - Math.cos(radians) * 91 }, chosen && { backgroundColor: colors.primarySoft }]}>
                  <ThemedText style={chosen ? { color: colors.primary, fontWeight: '700' } : undefined}>{step === 'minute' ? String(label).padStart(2, '0') : label}</ThemedText>
                </View>;
              })}
            </View>
            <View style={styles.adjust}>
              <Button size="sm" variant="outline" disabled={busy} accessibilityLabel={step === 'hour' ? 'Уменьшить часы' : 'Уменьшить минуты'} onPress={() => step === 'hour' ? setHour((hour + 10) % 12 + 1) : setMinute((minute + 59) % 60)}>−</Button>
              <ThemedText type="h3">{String(hour).padStart(2, '0')}:{String(minute).padStart(2, '0')} {period}</ThemedText>
              <Button size="sm" variant="outline" disabled={busy} accessibilityLabel={step === 'hour' ? 'Увеличить часы' : 'Увеличить минуты'} onPress={() => step === 'hour' ? setHour(hour % 12 + 1) : setMinute((minute + 1) % 60)}>+</Button>
            </View>
            <SegmentedControl value={period} onChange={setPeriod} disabled={busy} accessibilityLabel="Половина суток"
              options={[{ value: 'AM', label: 'AM · до полудня' }, { value: 'PM', label: 'PM · после полудня' }]} />
            {step === 'hour' ? <Button size="sm" variant="ghost" disabled={busy} onPress={() => setStep('minute')}>Выбрать минуты</Button> : null}
          </View>}
          <ThemedText type="small">{selected ? formatDeadline(selected.toISOString()) : 'Недоступное местное время'}</ThemedText>
          <ThemedText type="caption">Часовой пояс: {timezone}. {selected ? formatUtcOffset(selected.getTimezoneOffset()) : ''}</ThemedText>
          {candidates.length > 1 && selected ? <View style={styles.calendar}>
            <ThemedText type="small">При переводе часов это время наступает дважды. Выберите смещение.</ThemedText>
            <SegmentedControl value={String(selected.getTimezoneOffset())} onChange={(value) => setOffset(Number(value))} disabled={busy}
              accessibilityLabel="Смещение при переводе часов" options={candidates.map((candidate) => ({ value: String(candidate.getTimezoneOffset()), label: formatUtcOffset(candidate.getTimezoneOffset()) }))} />
          </View> : null}
          {error || validation ? <ThemedText type="small" accessibilityRole="alert" style={{ color: colors.destructive }}>{error || validation}</ThemedText> : null}
          <View style={styles.footer}>
            <Button variant="outline" disabled={busy} onPress={onCancel}>Отмена</Button>
            <Button loading={busy} disabled={busy || step !== 'minute'} onPress={handleConfirm}>Подтвердить</Button>
          </View>
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 12 },
  sheet: { width: '100%', maxWidth: 400, maxHeight: '92%', borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  body: { padding: 16, gap: 16 }, calendar: { gap: 4 }, month: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  monthTitle: { flex: 1, textAlign: 'center' }, days: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: { width: '14.2857%', height: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 22 }, disabled: { opacity: 0.3 },
  clock: { alignItems: 'center', gap: 12 }, face: { width: FACE_SIZE, height: FACE_SIZE, borderRadius: FACE_SIZE / 2 },
  dialNumber: { position: 'absolute', width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  hand: { position: 'absolute', left: 125, top: 32, width: 2, height: 94 }, hub: { position: 'absolute', left: 122, top: 122, width: 8, height: 8, borderRadius: 4 },
  adjust: { flexDirection: 'row', alignItems: 'center', gap: 16 }, footer: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 },
});
