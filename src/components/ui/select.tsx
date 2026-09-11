import { useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { radii, spacing } from '@/components/ui/theme';
import { ThemedText } from '@/components/ui/text';
import { useTheme } from './theme-provider';

export type SelectOption = { value: string; label: string };

export function Select({
  label,
  value,
  options,
  onChange,
  placeholder = 'Выберите значение',
  accessibilityLabel,
}: {
  label?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  accessibilityLabel: string;
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
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        style={[styles.trigger, { borderColor: theme.borderStrong, backgroundColor: theme.surface }]}
      >
        <ThemedText style={styles.triggerText} numberOfLines={1}>
          {selected?.label || placeholder}
        </ThemedText>
        <ThemedText type="caption" style={{ color: theme.textMuted }}>▾</ThemedText>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={[styles.backdrop, { backgroundColor: theme.overlay }]}>
          <Pressable style={styles.dismissLayer} onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Закрыть список" />
          <View style={[styles.menu, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            {label ? <ThemedText type="h3">{label}</ThemedText> : null}
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
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  trigger: { minHeight: 48, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  triggerText: { flex: 1 },
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
  dismissLayer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  menu: { width: '100%', maxWidth: 480, maxHeight: '80%', borderWidth: 1, borderRadius: radii.md, padding: spacing.lg, gap: spacing.md },
  list: { flexGrow: 0 },
  option: { minHeight: 48, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radii.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  optionText: { flex: 1 },
});
