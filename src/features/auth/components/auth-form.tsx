import type { ReactNode } from 'react';
import { Link, type Href } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/ui/text';
import { layout, radii, spacing } from '@/components/ui/theme';
import { useTheme } from '@/components/ui/theme-provider';

export function AuthForm({ title, description, children, footer }: { title: string; description: string; children: ReactNode; footer?: ReactNode }) {
  const { colors } = useTheme();
  return <Screen scrollable maxWidth={layout.authMaxWidth} contentStyle={styles.screen}>
    <View style={styles.brand}>
      <ThemedText type="h2" style={{ color: colors.primary }}>TaskTrace</ThemedText>
      <ThemedText type="small">Этапы, команда и история действий</ThemedText>
    </View>
    <Card style={styles.card}>
      <View style={styles.heading}>
        <ThemedText type="h1">{title}</ThemedText>
        <ThemedText type="small">{description}</ThemedText>
      </View>
      {children}
    </Card>
    {footer ? <View style={styles.footer}>{footer}</View> : null}
  </Screen>;
}

export function AuthLink({ href, children, primary = false }: { href: Href; children: ReactNode; primary?: boolean }) {
  return <Link href={href} asChild><Button accessibilityRole="link" fullWidth variant={primary ? 'primary' : 'ghost'}>{children}</Button></Link>;
}

export function AuthNotice({ title, children }: { title: string; children: ReactNode }) {
  const { colors } = useTheme();
  return <View accessibilityLiveRegion="polite" style={[styles.notice, { backgroundColor: colors.successSoft }]}>
    <ThemedText type="h3" style={{ color: colors.success }}>{title}</ThemedText>
    <ThemedText type="small">{children}</ThemedText>
  </View>;
}

const styles = StyleSheet.create({
  screen: { gap: spacing.xl, paddingVertical: spacing.xxl },
  brand: { alignItems: 'center', gap: spacing.xs },
  card: { width: '100%', gap: spacing.lg, padding: spacing.xl },
  heading: { gap: spacing.sm, marginBottom: spacing.xs },
  footer: { width: '100%', gap: spacing.xs, alignItems: 'center' },
  notice: { gap: spacing.sm, borderRadius: radii.md, padding: spacing.lg },
});
