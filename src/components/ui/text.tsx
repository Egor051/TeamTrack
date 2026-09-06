import { StyleSheet, Text, type TextProps } from 'react-native';
import { colors } from '@/components/ui/theme';
import { useTheme } from './theme-provider';
type TextType = 'title' | 'h1' | 'h2' | 'h3' | 'body' | 'small' | 'caption' | 'code';
type ThemedTextProps = { type?: TextType } & TextProps;
export function ThemedText({ type = 'body', style, children, ...rest }: ThemedTextProps) { const { colors: theme } = useTheme(); return <Text style={[styles[type], { color: type === 'small' || type === 'caption' ? theme.textSecondary : theme.text }, style]} {...rest}>{children}</Text>; }
const styles = StyleSheet.create({
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700', color: colors.text }, h1: { fontSize: 24, lineHeight: 30, fontWeight: '700', color: colors.text }, h2: { fontSize: 20, lineHeight: 26, fontWeight: '600', color: colors.text }, h3: { fontSize: 18, lineHeight: 24, fontWeight: '600', color: colors.text }, body: { fontSize: 16, lineHeight: 24, fontWeight: '400', color: colors.text }, small: { fontSize: 14, lineHeight: 20, fontWeight: '400', color: colors.textSecondary }, caption: { fontSize: 12, lineHeight: 16, fontWeight: '400', color: colors.textSecondary }, code: { fontSize: 13, lineHeight: 19, fontWeight: '400', fontFamily: 'monospace', color: colors.text },
});
export default ThemedText;
