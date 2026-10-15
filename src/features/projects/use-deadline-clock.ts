import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { nextDeadlineBoundary, type DeadlineItem } from './deadlines';

/** One boundary timer per visible screen, with no HTTP requests or polling. */
export function useDeadlineClock(items: readonly DeadlineItem[]) {
  const [now, setNow] = useState(Date.now);
  const next = nextDeadlineBoundary(items, now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => setNow(Date.now());
    if (next !== null) timer = setTimeout(refresh, Math.max(1, Math.min(next - Date.now(), 86_400_000)));
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') refresh(); });
    if (Platform.OS === 'web') {
      window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    }
    return () => {
      if (timer) clearTimeout(timer); subscription.remove();
      if (Platform.OS === 'web') { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); }
    };
  }, [next, now]);
  return now;
}
