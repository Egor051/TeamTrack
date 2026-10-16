import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Button } from './button';
import { ThemedText } from './text';
import { SegmentedControl } from './segmented-control';
import { useTheme } from './theme-provider';
import { ModalLayer } from './modal-layer';
import { ClockFace } from './clock-face';
import { dialValue, FACE_SIZE, INNER_RADIUS, OUTER_RADIUS } from './clock-dial';
import { formatDeadline, formatUtcOffset, isFutureDeadline, localDeadlineCandidates } from '@/features/projects/deadlines';
export { dialValue } from './clock-dial';

type Step = 'date' | 'hour' | 'minute';
export function DeadlinePicker({ value, busy, error, onCancel, onSave, futureOnly = true, title }: {
  value: string | null; busy: boolean; error?: string; onCancel: () => void; onSave: (iso: string) => Promise<void>;
  futureOnly?: boolean; title?: string;
}) {
  const { colors } = useTheme();
  const [initial] = useState(() => value ? new Date(value) : new Date());
  const [date, setDate] = useState<{ year: number; month: number; day: number } | null>(() => value ? { year: initial.getFullYear(), month: initial.getMonth(), day: initial.getDate() } : null);
  const [month, setMonth] = useState(new Date(initial.getFullYear(), initial.getMonth(), 1));
  const [hour, setHour] = useState<number | null>(value ? initial.getHours() : null);
  const [minute, setMinute] = useState<number | null>(value ? initial.getMinutes() : null);
  const [offset, setOffset] = useState(initial.getTimezoneOffset());
  const [step, setStep] = useState<Step>('date');
  const [validation, setValidation] = useState('');
  const complete = date !== null && hour !== null && minute !== null;
  const candidates = complete ? localDeadlineCandidates(date.year, date.month, date.day, hour, minute) : [];
  const selected = candidates.find((candidate) => candidate.getTimezoneOffset() === offset) ?? candidates[0] ?? null;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const first = (month.getDay() + 6) % 7;
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const moveMonth = (delta: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));
  const adjust = (delta: number) => { if (step === 'hour') setHour(((hour ?? initial.getHours()) + delta + 24) % 24); else setMinute(((minute ?? initial.getMinutes()) + delta + 60) % 60); setValidation(''); };
  const handleConfirm = async () => {
    if (!complete) { setValidation('Выберите дату, часы и минуты.'); return; }
    if (!selected) { setValidation('Это время недоступно из-за перевода часов. Выберите другое.'); return; }
    if (futureOnly && !isFutureDeadline(selected.getTime())) { setValidation('Выберите дату и время в будущем.'); return; }
    setValidation(''); await onSave(selected.toISOString());
  };
  const dial = step === 'hour' ? hour : minute;
  const angle = (step === 'hour' ? (hour ?? 0) % 12 / 12 : (minute ?? 0) / 60) * 360;
  const radius = step === 'hour' && hour !== null && hour >= 1 && hour <= 12 ? INNER_RADIUS : OUTER_RADIUS;
  return <ModalLayer visible onClose={onCancel} busy={busy} contentStyle={styles.sheet} label={title || 'Выбор даты и времени'}>
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <ThemedText type="h3">{title || (value ? 'Изменить дедлайн' : 'Установить дедлайн')}</ThemedText>
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
          const disabled = busy || (futureOnly && current < today);
          const chosen = date?.year === month.getFullYear() && date.month === month.getMonth() && date.day === day;
          return <Pressable key={index} accessibilityRole="button" accessibilityLabel={current.toLocaleDateString('ru-RU', { dateStyle: 'full' })}
            accessibilityState={{ selected: chosen, disabled }} disabled={disabled}
            onPress={() => { setDate({ year: month.getFullYear(), month: month.getMonth(), day }); setValidation(''); setStep('hour'); }}
            style={[styles.dayCell, current.getTime() === today.getTime() && { borderColor: colors.primary, borderWidth: 1 }, chosen && { backgroundColor: colors.primarySoft }, disabled && styles.disabled]}>
            <ThemedText selectable={false} style={chosen ? { color: colors.primary, fontWeight: '700' } : undefined}>{day}</ThemedText>
          </Pressable>;
        })}</View>
      </View> : <View style={styles.clock}>
        <ThemedText type="small">{step === 'hour' ? 'Выберите часы' : 'Выберите минуты'}</ThemedText>
        <ClockFace label={step === 'hour' ? `Часы: ${hour ?? 'не выбраны'}` : `Минуты: ${minute ?? 'не выбраны'}`} value={dial} max={step === 'hour' ? 23 : 59}
          busy={busy} background={colors.surfaceMuted} onAdjust={adjust} onFinish={() => { if (step === 'hour') setStep('minute'); }}
          onPoint={(x, y) => { const next = dialValue(x, y, step); if (step === 'hour') setHour(next); else setMinute(next); setValidation(''); }}>
          {dial !== null ? <View pointerEvents="none" style={[styles.hand, { top: FACE_SIZE / 2 - radius, height: radius, backgroundColor: colors.primary,
            transform: [{ translateY: radius / 2 }, { rotate: `${angle}deg` }, { translateY: -radius / 2 }] }]} /> : null}
          <View pointerEvents="none" style={[styles.hub, { backgroundColor: colors.primary }]} />
          {Array.from({ length: step === 'hour' ? 24 : 12 }, (_, index) => {
            const inner = step === 'hour' && index >= 12;
            const slot = index % 12; const radians = slot * Math.PI / 6;
            const label = step === 'minute' ? slot * 5 : inner ? slot || 12 : slot === 0 ? 0 : slot + 12;
            const chosen = dial === label; const r = inner ? INNER_RADIUS : OUTER_RADIUS;
            return <View pointerEvents="none" key={index} style={[styles.dialNumber, { left: 110 + Math.sin(radians) * r, top: 110 - Math.cos(radians) * r }, chosen && { backgroundColor: colors.primarySoft }]}>
              <ThemedText selectable={false} style={[styles.number, chosen && { color: colors.primary, fontWeight: '700' }]}>{step === 'minute' || label === 0 ? String(label).padStart(2, '0') : label}</ThemedText>
            </View>;
          })}
        </ClockFace>
        <View style={styles.adjust}>
          <Button size="sm" variant="outline" disabled={busy} accessibilityLabel={step === 'hour' ? 'Уменьшить часы' : 'Уменьшить минуты'} onPress={() => adjust(-1)}>−</Button>
          <ThemedText type="h3">{hour === null ? '––' : String(hour).padStart(2, '0')}:{minute === null ? '––' : String(minute).padStart(2, '0')}</ThemedText>
          <Button size="sm" variant="outline" disabled={busy} accessibilityLabel={step === 'hour' ? 'Увеличить часы' : 'Увеличить минуты'} onPress={() => adjust(1)}>+</Button>
        </View>
        {step === 'hour' ? <Button size="sm" variant="ghost" disabled={busy || hour === null} onPress={() => setStep('minute')}>Выбрать минуты</Button> : null}
      </View>}
      <ThemedText type="small">{selected ? formatDeadline(selected.toISOString()) : complete ? 'Недоступное местное время' : 'Дата и время не выбраны'}</ThemedText>
      <ThemedText type="caption">Часовой пояс: {timezone}. {selected ? formatUtcOffset(selected.getTimezoneOffset()) : ''}</ThemedText>
      {candidates.length > 1 && selected ? <View style={styles.calendar}>
        <ThemedText type="small">При переводе часов это время наступает дважды. Выберите смещение.</ThemedText>
        <SegmentedControl value={String(selected.getTimezoneOffset())} onChange={(value) => setOffset(Number(value))} disabled={busy}
          accessibilityLabel="Смещение при переводе часов" options={candidates.map((candidate) => ({ value: String(candidate.getTimezoneOffset()), label: formatUtcOffset(candidate.getTimezoneOffset()) }))} />
      </View> : null}
      {error || validation ? <ThemedText type="small" accessibilityRole="alert" style={{ color: colors.destructive }}>{error || validation}</ThemedText> : null}
      <View style={styles.footer}><Button variant="outline" disabled={busy} onPress={onCancel}>Отмена</Button><Button loading={busy} disabled={busy || !complete} onPress={handleConfirm}>Подтвердить</Button></View>
    </ScrollView>
  </ModalLayer>;
}
const styles = StyleSheet.create({
  sheet: { maxWidth: 400 }, body: { padding: 16, gap: 16 }, calendar: { gap: 4 }, month: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  monthTitle: { flex: 1, textAlign: 'center' }, days: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: { width: '14.2857%', height: 44, justifyContent: 'center', alignItems: 'center', borderRadius: 22 }, disabled: { opacity: 0.3 },
  clock: { alignItems: 'center', gap: 12 }, dialNumber: { position: 'absolute', width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  number: { fontSize: 14 }, hand: { position: 'absolute', left: 125, width: 2 }, hub: { position: 'absolute', left: 122, top: 122, width: 8, height: 8, borderRadius: 4 },
  adjust: { flexDirection: 'row', alignItems: 'center', gap: 16 }, footer: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 },
});
