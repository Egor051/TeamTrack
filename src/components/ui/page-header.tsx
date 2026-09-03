import { StyleSheet, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { ThemedText } from '@/components/ui/text';
import { colors, spacing } from '@/components/ui/theme';
export function PageHeader({ title, subtitle, onBack, actions }: { title: string; subtitle?: string; onBack?: () => void; actions?: React.ReactNode }) { return <View style={styles.header}><View style={styles.leading}>{onBack ? <Button size="sm" variant="ghost" accessibilityLabel="Назад" onPress={onBack}>‹ Назад</Button> : null}<View style={styles.titles}><ThemedText type="h1">{title}</ThemedText>{subtitle ? <ThemedText type="small" style={styles.subtitle}>{subtitle}</ThemedText> : null}</View></View>{actions ? <View style={styles.actions}>{actions}</View> : null}</View>; }
const styles = StyleSheet.create({ header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: spacing.lg }, leading: { flex: 1, minWidth: 220, gap: spacing.xs }, titles: { gap: spacing.xs }, subtitle: { color: colors.textSecondary }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' } });
