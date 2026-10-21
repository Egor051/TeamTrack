import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { getUtcPlus3DayStart } from './day';

/** Day identity belongs to the view too, including native/offline views. */
export function useCurrentDay(): string {
  const [day, setDay] = useState(() => getUtcPlus3DayStart());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      clearTimeout(timer);
      const next = getUtcPlus3DayStart();
      setDay(next);
      timer = setTimeout(check, Math.max(1, Date.parse(next) + 86400000 - Date.now()));
    };
    const active = AppState.addEventListener('change', (state) => { if (state === 'active') check(); });
    const visible = () => { if (typeof document === 'undefined' || document.visibilityState === 'visible') check(); };
    if (typeof window !== 'undefined') window.addEventListener('focus', check);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visible);
    check();
    return () => {
      clearTimeout(timer); active.remove();
      if (typeof window !== 'undefined') window.removeEventListener('focus', check);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  return day;
}
