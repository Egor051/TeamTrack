import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { ThemedText } from '@/components/ui/text';
import { colors, spacing } from '@/components/ui/theme';
import { useTheme } from './theme-provider';
export function LoadingState({ label = 'Загрузка...' }: { label?: string }) { const { colors: theme } = useTheme(); return <View accessibilityRole="progressbar" style={styles.state}><ActivityIndicator color={theme.primary} /><ThemedText type="small">{label}</ThemedText></View>; }
export function EmptyState({ title, description, actionLabel, onAction }: { title: string; description: string; actionLabel?: string; onAction?: () => void }) { return <View style={styles.empty}><ThemedText type="h3">{title}</ThemedText><ThemedText style={styles.copy}>{description}</ThemedText>{actionLabel && onAction ? <Button size="sm" onPress={onAction}>{actionLabel}</Button> : null}</View>; }
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) { return <View accessibilityRole="alert" style={styles.empty}><ThemedText type="h3" style={styles.errorTitle}>Не удалось загрузить данные</ThemedText><ThemedText style={styles.copy}>{message}</ThemedText>{onRetry ? <Button size="sm" variant="outline" onPress={onRetry}>Повторить</Button> : null}</View>; }
const styles = StyleSheet.create({ state: { minHeight: 96, alignItems: 'center', justifyContent: 'center', gap: spacing.sm }, empty: { minHeight: 152, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm }, copy: { color: colors.textSecondary, textAlign: 'center', maxWidth: 520 }, errorTitle: { color: colors.error } });
