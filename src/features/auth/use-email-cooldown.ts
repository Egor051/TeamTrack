import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import {
  authEmailCooldownKey, cooldownSeconds, emailRequestPending, readEmailCooldown,
  subscribeEmailCooldown, type AuthEmailOperation,
} from './email-cooldown';

export function useEmailCooldown(operation: AuthEmailOperation, email: string) {
  const key = authEmailCooldownKey(operation, email);
  const [snapshot, setSnapshot] = useState({ key: '', until: 0, pending: false });
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let cancelled = false;
    let revision = 0;
    const refresh = async () => {
      const currentRevision = ++revision;
      const until = await readEmailCooldown(key);
      if (cancelled || currentRevision !== revision) return;
      setSnapshot({ key, until, pending: emailRequestPending(key) });
      setNow(Date.now());
    };
    const unsubscribe = subscribeEmailCooldown(key, () => { void refresh(); });
    const appState = AppState.addEventListener('change', (state) => { if (state === 'active') void refresh(); });
    const onFocus = () => { void refresh(); };
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh(); };
    const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) void refresh(); };
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus);
      window.addEventListener('storage', onStorage);
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    void refresh();
    return () => {
      cancelled = true;
      unsubscribe();
      appState.remove();
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('storage', onStorage);
      }
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [key]);

  const checking = snapshot.key !== key;
  const remainingSeconds = checking ? 0 : cooldownSeconds(snapshot.until, now);
  const active = remainingSeconds > 0;

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, key]);

  useEffect(() => {
    if (!checking && snapshot.until > 0 && !active) void readEmailCooldown(key);
  }, [active, checking, key, snapshot.until]);

  return {
    remainingSeconds,
    disabled: checking || snapshot.pending || active,
    label: active ? `Отправить повторно через ${remainingSeconds} с` : 'Отправить повторно',
    // Keep a stable accessible label outside any live region, avoiding ticks.
    accessibilityLabel: active ? 'Повторная отправка временно недоступна' : 'Отправить повторно',
  };
}
