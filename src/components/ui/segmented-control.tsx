import { Pressable, StyleSheet, View } from 'react-native';
import { ThemedText } from '@/components/ui/text';
import { radii } from '@/components/ui/theme';
import { useTheme } from './theme-provider';

export function SegmentedControl<T extends string>({ value, options, onChange, accessibilityLabel, disabled = false }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; accessibilityLabel: string; disabled?: boolean }) {
  const { colors: theme } = useTheme();
  return <View accessibilityRole="tablist" accessibilityLabel={accessibilityLabel} style={[styles.container, { borderColor: theme.border, backgroundColor: theme.surfaceMuted }, disabled && { opacity: 0.5 }]}>{options.map((option) => {
    const selected = option.value === value;
    return <Pressable key={option.value} accessibilityRole="tab" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={() => onChange(option.value)} style={({ pressed }) => [styles.option, selected && { backgroundColor: theme.surface, borderColor: theme.border }, pressed && { opacity: 0.7 }]}><ThemedText type="small" style={[styles.text, selected && { color: theme.primary }]}>{option.label}</ThemedText></Pressable>;
  })}</View>;
}
const styles = StyleSheet.create({ container: { flexDirection: 'row', flexWrap: 'wrap', alignSelf: 'flex-start', maxWidth: '100%', borderWidth: 1, borderRadius: radii.md, padding: 3, gap: 3 }, option: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radii.sm, borderWidth: 1, borderColor: 'transparent', flexShrink: 1 }, text: { fontWeight: '600', textAlign: 'center' } });
