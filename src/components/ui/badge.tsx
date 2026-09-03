import { StyleSheet, View } from 'react-native';
import { ThemedText } from '@/components/ui/text';
import { colors, radii } from '@/components/ui/theme';
type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
export function Badge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: Tone }) { return <View style={[styles.badge, styles[`${tone}Bg`]]}><ThemedText type="caption" style={[styles.text, styles[`${tone}Text`]]}>{children}</ThemedText></View>; }
const styles = StyleSheet.create({ badge: { alignSelf: 'flex-start', borderRadius: radii.sm, paddingHorizontal: 8, paddingVertical: 4 }, text: { fontWeight: '700' }, neutralBg: { backgroundColor: colors.surfaceMuted }, neutralText: { color: colors.secondary }, primaryBg: { backgroundColor: colors.primarySoft }, primaryText: { color: colors.primary }, successBg: { backgroundColor: colors.successSoft }, successText: { color: colors.success }, warningBg: { backgroundColor: colors.warningSoft }, warningText: { color: colors.warning }, dangerBg: { backgroundColor: colors.destructiveSoft }, dangerText: { color: colors.destructive } });
