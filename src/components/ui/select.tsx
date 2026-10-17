import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { ModalLayer } from './modal-layer';
import { radii, spacing } from '@/components/ui/theme';
import { ThemedText } from '@/components/ui/text';
import { useTheme } from './theme-provider';
import { Button } from './button';

export type SelectOption = { value: string; label: string };

export function MultiSelect({ label, value, options, onChange, placeholder, accessibilityLabel }: {
  label: string; value: string[]; options: SelectOption[]; onChange: (values: string[]) => void;
  placeholder: string; accessibilityLabel: string;
}) {
  const { colors: theme } = useTheme();
  const [open, setOpen] = useState(false);
  const summary = value.length ? `Выбрано: ${value.length}` : placeholder;
  return <View style={styles.container}>
    <ThemedText type="small">{label}</ThemedText>
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityValue={{ text: summary }}
      accessibilityState={{ expanded: open }} onPress={() => setOpen(true)}
      style={[styles.trigger, { borderColor: theme.borderStrong, backgroundColor: theme.surface }]}>
      <ThemedText style={styles.triggerText} numberOfLines={1}>{summary}</ThemedText><ThemedText type="caption">▾</ThemedText>
    </Pressable>
    <ModalLayer visible={open} onClose={() => setOpen(false)} label={label} contentStyle={styles.menu}>
      <View style={styles.menuHeader}><ThemedText type="h3" style={styles.optionText}>{label}</ThemedText>
        <Button size="sm" variant="ghost" onPress={() => onChange([])}>Снять все</Button></View>
      <FlatList data={options} keyExtractor={(option) => option.value} style={styles.list}
        keyboardShouldPersistTaps="handled" renderItem={({ item: option }) => <Pressable accessibilityRole="checkbox"
          accessibilityLabel={option.label} accessibilityState={{ checked: value.includes(option.value) }} style={styles.option}
          onPress={() => onChange(value.includes(option.value) ? value.filter((entry) => entry !== option.value) : [...value, option.value])}>
          <ThemedText style={styles.optionText}>{option.label}</ThemedText><ThemedText style={{ color: theme.primary }}>{value.includes(option.value) ? '☑' : '☐'}</ThemedText>
        </Pressable>} />
      <Button size="sm" onPress={() => setOpen(false)}>Готово</Button>
    </ModalLayer>
  </View>;
}

export function Select({
  label,
  value,
  options,
  onChange,
  placeholder = 'Выберите значение',
  accessibilityLabel,
  disabled = false,
}: {
  label?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  accessibilityLabel: string;
  disabled?: boolean;
}) {
  const { colors: theme } = useTheme();
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);

  function choose(nextValue: string) {
    onChange(nextValue);
    setOpen(false);
  }

  return (
    <View style={styles.container}>
      {label ? <ThemedText type="small">{label}</ThemedText> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ text: selected?.label || placeholder }}
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={[styles.trigger, { borderColor: theme.borderStrong, backgroundColor: disabled ? theme.surfaceMuted : theme.surface }, disabled && { opacity: 0.5 }]}
      >
        <ThemedText style={styles.triggerText} numberOfLines={1}>
          {selected?.label || placeholder}
        </ThemedText>
        <ThemedText type="caption" style={{ color: theme.textMuted }}>▾</ThemedText>
      </Pressable>
      <ModalLayer visible={open} onClose={() => setOpen(false)} label={label || accessibilityLabel} contentStyle={styles.menu}>
            <View style={styles.menuHeader}><ThemedText type="h3" style={styles.optionText}>{label || accessibilityLabel}</ThemedText><Pressable accessibilityRole="button" accessibilityLabel="Закрыть список" onPress={() => setOpen(false)} style={styles.close}><ThemedText>✕</ThemedText></Pressable></View>
            <FlatList
              data={options}
              keyExtractor={(option) => option.value}
              style={styles.list}
              renderItem={({ item: option }) => {
                const isSelected = option.value === value;
                return (
                  <Pressable
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => choose(option.value)}
                    style={[styles.option, isSelected && { backgroundColor: theme.surfaceMuted }]}
                  >
                    <ThemedText style={styles.optionText}>{option.label}</ThemedText>
                    {isSelected ? <ThemedText type="caption" style={{ color: theme.primary }}>Выбрано</ThemedText> : null}
                  </Pressable>
                );
              }}
            />
      </ModalLayer>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  menuHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  close: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  trigger: { minHeight: 48, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  triggerText: { flex: 1 },
  menu: { maxWidth: 480, maxHeight: '80%', padding: spacing.lg, gap: spacing.md },
  list: { flexGrow: 0 },
  option: { minHeight: 48, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radii.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  optionText: { flex: 1 },
});
