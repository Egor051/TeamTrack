import { Fragment } from 'react';
import { StyleSheet, View } from 'react-native';
import { Link, router, type Href } from 'expo-router';
import { Button } from '@/components/ui/button';
import { ThemedText } from '@/components/ui/text';
import { spacing } from '@/components/ui/theme';

export type Breadcrumb = { label: string; href?: string };
export function PageHeader({ title, subtitle, onBack, backLabel = 'Назад', breadcrumbs, actions }: { title: string; subtitle?: string; onBack?: () => void; backLabel?: string; breadcrumbs?: Breadcrumb[]; actions?: React.ReactNode }) {
  const goBack = () => { if (onBack) { onBack(); return; } if (router.canGoBack()) router.back(); else router.replace((breadcrumbs?.filter((crumb) => crumb.href).at(-1)?.href || '/projects') as Href); };
  const hasBack = Boolean(onBack || breadcrumbs?.some((crumb) => crumb.href));
  return <View style={styles.container}>
    {hasBack ? <View style={styles.back}><Button size="sm" variant="ghost" accessibilityLabel={backLabel} onPress={goBack}>‹ {backLabel}</Button></View> : null}
    {breadcrumbs?.length ? <View accessibilityLabel="Путь к текущей странице" style={styles.breadcrumbs}>{breadcrumbs.map((crumb, index) => <Fragment key={crumb.label + index}>
      {index > 0 ? <ThemedText type="caption" accessibilityElementsHidden>›</ThemedText> : null}
      {crumb.href ? <Link href={crumb.href as Href} asChild><Button accessibilityRole="link" variant="ghost" size="sm" style={styles.crumb}>{crumb.label}</Button></Link> : <ThemedText type="small" style={styles.current}>{crumb.label}</ThemedText>}
    </Fragment>)}</View> : null}
    <View style={styles.header}><View style={styles.titles}><ThemedText type="h1">{title}</ThemedText>{subtitle ? <ThemedText type="small">{subtitle}</ThemedText> : null}</View>{actions ? <View style={styles.actions}>{actions}</View> : null}</View>
  </View>;
}
const styles = StyleSheet.create({ container: { gap: spacing.md }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: spacing.lg }, titles: { flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 0, gap: spacing.sm }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center', maxWidth: '100%' }, breadcrumbs: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs }, crumb: { paddingHorizontal: spacing.sm }, current: { flexShrink: 1, paddingHorizontal: spacing.sm }, back: { alignSelf: 'flex-start' } });
