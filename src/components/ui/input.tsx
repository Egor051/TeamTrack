import { forwardRef, useId, useState } from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { ThemedText } from '@/components/ui/text';
import { radii, spacing } from '@/components/ui/theme';
import { useTheme } from './theme-provider';

export type InputProps = { onChangeText: (text: string) => void; type?: 'text' | 'email' | 'password'; disabled?: boolean; error?: string; label?: string; hint?: string } & TextInputProps;
export const Input = forwardRef<TextInput, InputProps>(function Input({ type = 'text', disabled = false, error, label, hint, style, onFocus, onBlur, editable, ...rest }, ref) {
  const { colors: theme } = useTheme();
  const [focused, setFocused] = useState(false);
  const helperId = useId();
  const unavailable = disabled || editable === false;
  return <View style={styles.container}>
    {label ? <ThemedText type="small" style={[styles.label, { color: theme.text }]}>{label}</ThemedText> : null}
    <TextInput
      ref={ref}
      {...rest}
      value={rest.value}
      autoCapitalize={rest.autoCapitalize ?? 'none'}
      keyboardType={rest.keyboardType ?? (type === 'email' ? 'email-address' : 'default')}
      secureTextEntry={type === 'password' || rest.secureTextEntry}
      autoCorrect={rest.autoCorrect ?? false}
      spellCheck={rest.spellCheck ?? false}
      editable={!unavailable}
      placeholderTextColor={theme.textMuted}
      accessibilityLabel={rest.accessibilityLabel || label || rest.placeholder}
      accessibilityState={{ ...rest.accessibilityState, disabled: unavailable }}
      aria-invalid={Boolean(error)}
      aria-describedby={error || hint ? helperId : undefined}
      onFocus={(event) => { setFocused(true); onFocus?.(event); }}
      onBlur={(event) => { setFocused(false); onBlur?.(event); }}
      style={[styles.input, { borderColor: error ? theme.error : focused ? theme.primary : theme.borderStrong, backgroundColor: unavailable ? theme.surfaceMuted : theme.surface, color: theme.text }, rest.multiline && styles.multiline, unavailable && styles.disabled, style]}
    />
    {error || hint ? <ThemedText nativeID={helperId} accessibilityRole={error ? 'alert' : undefined} type="caption" style={error ? { color: theme.error } : undefined}>{error || hint}</ThemedText> : null}
  </View>;
});
const styles = StyleSheet.create({ container: { width: '100%', gap: spacing.sm, minWidth: 0 }, label: { fontWeight: '600' }, input: { fontSize: 16, minHeight: 48, paddingHorizontal: 14, paddingVertical: 12, borderRadius: radii.md, borderWidth: 1, width: '100%' }, multiline: { minHeight: 112, textAlignVertical: 'top' }, disabled: { opacity: 0.6 } });
