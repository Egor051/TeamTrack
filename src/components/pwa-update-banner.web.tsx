import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { ThemedText } from '@/components/ui/text';
import { useTheme } from '@/components/ui/theme-provider';
import { spacing } from '@/components/ui/theme';

export function PwaUpdateBanner() {
  const { colors } = useTheme();
  const [waiting, setWaiting] = useState<ServiceWorkerRegistration | null>(null);
  const activatingRef = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    let disposed = false;
    let registration: ServiceWorkerRegistration | null = null;
    let installing: ServiceWorker | null = null;

    const onStateChange = () => {
      if (!disposed && registration?.waiting && navigator.serviceWorker.controller) setWaiting(registration);
    };
    const onUpdateFound = () => {
      installing?.removeEventListener('statechange', onStateChange);
      installing = registration?.installing ?? null;
      installing?.addEventListener('statechange', onStateChange);
    };
    const onControllerChange = () => {
      if (activatingRef.current) window.location.reload();
    };
    const checkForUpdate = () => {
      if (document.visibilityState === 'visible') void registration?.update().catch(() => undefined);
    };

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then((next) => {
      if (disposed) return;
      registration = next;
      next.addEventListener('updatefound', onUpdateFound);
      onUpdateFound();
      onStateChange();
      document.addEventListener('visibilitychange', checkForUpdate);
      void next.update().catch(() => undefined);
    }).catch((error: unknown) => {
      console.warn('[TaskTrace] Service Worker registration failed', error);
    });

    // Browser update checks on navigation; this also covers long-open tabs.
    const timer = window.setInterval(checkForUpdate, 60 * 60 * 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', checkForUpdate);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      registration?.removeEventListener('updatefound', onUpdateFound);
      installing?.removeEventListener('statechange', onStateChange);
    };
  }, []);

  if (!waiting) return null;
  return (
    <View style={[styles.banner, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <ThemedText type="small" style={styles.label}>Доступна новая версия TaskTrace.</ThemedText>
      <Button size="sm" onPress={() => {
        if (!waiting.waiting) return;
        // Apply only after the user chooses to reload, never during active work.
        activatingRef.current = true;
        waiting.waiting.postMessage({ type: 'SKIP_WAITING' });
      }}>Обновить</Button>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute', bottom: spacing.lg, left: spacing.lg, right: spacing.lg,
    zIndex: 1000, borderWidth: 1, borderRadius: 8, padding: spacing.md,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    flexWrap: 'wrap', gap: spacing.sm,
  },
  label: { flexShrink: 1 },
});
